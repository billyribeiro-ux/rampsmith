use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use domain::{ShopId, ShopStatus, TenantId};
use sqlx::postgres::{PgConnection, PgPool, PgPoolOptions};
use sqlx::{Postgres, Transaction};

use crate::DbError;
use crate::flights::{Flight, Flights};

/// How long a request waits in the database for another process's shop lock. Longer than the
/// 10-second Shopify call a holder makes, so an honest holder finishes first, and short enough
/// that a stuck one frees the waiter's connection (audit M5, ADR-041).
pub const SHOP_LOCK_TIMEOUT: Duration = Duration::from_secs(15);

/// A handle to the database that only opens tenant-scoped transactions.
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
    flights: Arc<Flights>,
    lock_timeout: Duration,
}

impl fmt::Debug for Db {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Db")
            .field("size", &self.pool.size())
            .finish_non_exhaustive()
    }
}

impl Db {
    /// A pool that connects on first use. The URL's role must be an application role, never
    /// the owner. Connecting lazily lets a service start, answer liveness, and report
    /// readiness only once the database is reachable (PLAN §22).
    pub fn connect_lazy(url: &str, max_connections: u32) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(5))
            .connect_lazy(url)?;
        Ok(Self::from_pool(pool))
    }

    /// Wraps an existing pool, for binaries and tests that configure their own. Clones of the
    /// returned handle share one in-process queue for [`Db::shop_lock`]; handles built from
    /// the same pool separately do not.
    #[must_use]
    pub fn from_pool(pool: PgPool) -> Self {
        let connections = pool.options().get_max_connections();
        Self {
            pool,
            flights: Arc::new(Flights::new(connections)),
            lock_timeout: SHOP_LOCK_TIMEOUT,
        }
    }

    /// This handle with another bound on how long [`Db::shop_lock`] waits in the database.
    #[must_use]
    pub const fn with_lock_timeout(mut self, timeout: Duration) -> Self {
        self.lock_timeout = timeout;
        self
    }

    /// The pool, for the sibling modules of this crate only.
    pub(crate) const fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Opens a transaction scoped to `tenant`: row-level security applies to every
    /// statement inside it.
    pub async fn tenant(&self, tenant: TenantId) -> Result<TenantTx, DbError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query!(
            "select set_config('app.tenant_id', $1, true)",
            tenant.to_string()
        )
        .fetch_one(&mut *tx)
        .await?;
        Ok(TenantTx {
            tx,
            tenant,
            flight: None,
        })
    }

    /// Checks the database answers, without touching tenant data.
    pub async fn ping(&self) -> Result<(), DbError> {
        sqlx::query!("select 1 as one")
            .fetch_one(&self.pool)
            .await?;
        Ok(())
    }

    /// Opens a transaction for standalone-dashboard identity (ADR-024). Identity rows are not
    /// tenant-owned; only the functions in `repo::identity` accept this transaction.
    pub async fn identity(&self) -> Result<IdentityTx, DbError> {
        Ok(IdentityTx {
            tx: self.pool.begin().await?,
        })
    }

    /// Opens a transaction over rows that no tenant owns: the free scanner's (ADR-267) and the
    /// retention sweeps'. Only the functions in `repo::free_scans` and `repo::retention` accept it.
    pub async fn public(&self) -> Result<PublicTx, DbError> {
        Ok(PublicTx {
            tx: self.pool.begin().await?,
        })
    }

    /// The tenant and shop for a shop domain, across tenants (ADR-022). Call it only after
    /// verifying a Shopify session token or webhook signature for that domain.
    pub async fn shop_by_domain(&self, shop_domain: &str) -> Result<Option<ShopRef>, DbError> {
        let mut conn = self.pool.acquire().await?;
        shop_by_domain(&mut conn, shop_domain).await
    }

    /// Serialises token exchange and refresh for one shop across every process (ADR-022,
    /// ADR-041). In this process the shop's requests queue up first, holding no connection
    /// (and only as many shops as half the pool may hold one at a time). Then one connection
    /// takes a transaction-scoped advisory lock, waiting at most the lock timeout
    /// ([`DbError::LockTimeout`] after that). The guard carries that connection on:
    /// [`ShopLock::shop_by_domain`] and [`ShopLock::into_tenant`] do the re-check and the
    /// store on it, so a holder needs exactly one connection.
    pub async fn shop_lock(&self, shop_domain: &str) -> Result<ShopLock, DbError> {
        let flight = self.flights.enter(shop_domain).await;
        let mut tx = self.pool.begin().await?;
        sqlx::query!(
            "select set_config('lock_timeout', $1, true)",
            format!("{}ms", self.lock_timeout.as_millis())
        )
        .fetch_one(&mut *tx)
        .await?;
        let locked = sqlx::query!(
            "select pg_advisory_xact_lock(hashtextextended('shopify.shop:' || $1, 0))",
            shop_domain
        )
        .fetch_one(&mut *tx)
        .await;
        if let Err(error) = locked {
            // Hand the connection back before reporting, not whenever the failed transaction
            // is eventually dropped.
            let _ = tx.rollback().await;
            return Err(
                match error
                    .as_database_error()
                    .and_then(sqlx::error::DatabaseError::code)
                {
                    // lock_not_available: the lock timeout expired.
                    Some(code) if code == "55P03" => DbError::LockTimeout,
                    _ => DbError::from(error),
                },
            );
        }
        Ok(ShopLock { tx, flight })
    }

    /// The newest migration applied to this database, or `None` before any.
    pub async fn schema_version(&self) -> Result<Option<i64>, DbError> {
        Ok(sqlx::query_scalar!("select app_schema_version()")
            .fetch_one(&self.pool)
            .await?)
    }

    /// Up to `limit` (1 to 1000) stored Shopify token rows that a master key other than
    /// `active_key_id` still wraps, across tenants, in shop id order after `after` (audit L6,
    /// ADR-045). Pass the last shop of the previous batch as `after`, and `None` for the first
    /// batch. Only the worker role may call this. It returns ids and a version, never
    /// ciphertext: read and write each row in its own [`Db::tenant`] transaction.
    pub async fn tokens_to_rewrap(
        &self,
        active_key_id: &str,
        after: Option<ShopId>,
        limit: i32,
    ) -> Result<Vec<RewrapCandidate>, DbError> {
        let rows = sqlx::query!(
            r#"select tenant_id as "tenant_id!", shop_id as "shop_id!", version as "version!"
                 from shopify_tokens_to_rewrap($1, $2, $3)"#,
            active_key_id,
            after.map(ShopId::as_uuid),
            limit,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| RewrapCandidate {
                tenant: TenantId::from_uuid(r.tenant_id),
                shop: ShopId::from_uuid(r.shop_id),
                version: r.version,
            })
            .collect())
    }

    /// How many stored Shopify token rows each master key id wraps, by key id (audit L6,
    /// ADR-045). A key is safe to remove from the key ring once it no longer appears. Only the
    /// worker role may call this.
    pub async fn token_key_counts(&self) -> Result<Vec<KeyCount>, DbError> {
        let rows = sqlx::query!(
            r#"select key_id as "key_id!", tokens as "tokens!" from shopify_token_key_counts()"#
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| KeyCount {
                key_id: r.key_id,
                tokens: r.tokens,
            })
            .collect())
    }
}

/// Looks a shop up by domain on `conn` (the `app_shop_by_domain` function, ADR-022).
async fn shop_by_domain(
    conn: &mut PgConnection,
    shop_domain: &str,
) -> Result<Option<ShopRef>, DbError> {
    let row = sqlx::query!(
        r#"select tenant_id as "tenant_id!", shop_id as "shop_id!", status as "status!"
             from app_shop_by_domain($1)"#,
        shop_domain
    )
    .fetch_optional(conn)
    .await?;
    row.map(|r| {
        Ok(ShopRef {
            tenant: TenantId::from_uuid(r.tenant_id),
            shop: ShopId::from_uuid(r.shop_id),
            status: crate::error::parse(&r.status, "shopify_shops.status")?,
        })
    })
    .transpose()
}

/// A shop found by [`Db::shop_by_domain`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShopRef {
    /// The tenant that owns the shop.
    pub tenant: TenantId,
    /// The shop.
    pub shop: ShopId,
    /// Its installation state.
    pub status: ShopStatus,
}

/// A token row that a retired master key still wraps, found by [`Db::tokens_to_rewrap`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewrapCandidate {
    /// The tenant that owns the shop.
    pub tenant: TenantId,
    /// The shop.
    pub shop: ShopId,
    /// The row's version when it was listed.
    pub version: i64,
}

/// How many token rows one master key id wraps; see [`Db::token_key_counts`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCount {
    /// The master key id stored on the rows.
    pub key_id: String,
    /// How many rows carry it.
    pub tokens: i64,
}

/// Holds a shop's token lock; see [`Db::shop_lock`].
pub struct ShopLock {
    // Declared first, so it drops first: the transaction ends and the database lock goes
    // before the next request for the shop in this process may start.
    tx: Transaction<'static, Postgres>,
    flight: Flight,
}

impl fmt::Debug for ShopLock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ShopLock").finish_non_exhaustive()
    }
}

impl ShopLock {
    /// The tenant and shop for a shop domain, read on the lock's own connection (see
    /// [`Db::shop_by_domain`]).
    pub async fn shop_by_domain(&mut self, shop_domain: &str) -> Result<Option<ShopRef>, DbError> {
        shop_by_domain(&mut self.tx, shop_domain).await
    }

    /// Scopes the lock's transaction to `tenant`. The advisory lock is held until the returned
    /// transaction commits, rolls back or is dropped, and the tenant's work runs on the
    /// connection that already holds it.
    pub async fn into_tenant(mut self, tenant: TenantId) -> Result<TenantTx, DbError> {
        sqlx::query!(
            "select set_config('app.tenant_id', $1, true)",
            tenant.to_string()
        )
        .fetch_one(&mut *self.tx)
        .await?;
        Ok(TenantTx {
            tx: self.tx,
            tenant,
            flight: Some(self.flight),
        })
    }

    /// Releases the lock.
    pub async fn release(self) -> Result<(), DbError> {
        self.tx.commit().await?;
        Ok(())
    }
}

/// A transaction over identity rows only (ADR-024); see [`Db::identity`].
pub struct IdentityTx {
    tx: Transaction<'static, Postgres>,
}

impl fmt::Debug for IdentityTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityTx").finish_non_exhaustive()
    }
}

impl IdentityTx {
    /// Commits the transaction.
    pub async fn commit(self) -> Result<(), DbError> {
        self.tx.commit().await?;
        Ok(())
    }

    /// Rolls the transaction back.
    pub async fn rollback(self) -> Result<(), DbError> {
        self.tx.rollback().await?;
        Ok(())
    }

    /// The connection, for the identity repository only.
    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}

/// A transaction over rows that belong to no tenant: the free scanner's (ADR-267) and the
/// retention sweeps'; see [`Db::public`].
pub struct PublicTx {
    tx: Transaction<'static, Postgres>,
}

impl fmt::Debug for PublicTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PublicTx").finish_non_exhaustive()
    }
}

impl PublicTx {
    /// Commits the transaction.
    pub async fn commit(self) -> Result<(), DbError> {
        self.tx.commit().await?;
        Ok(())
    }

    /// Rolls the transaction back.
    pub async fn rollback(self) -> Result<(), DbError> {
        self.tx.rollback().await?;
        Ok(())
    }

    /// The connection, for the free-scan repository only.
    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}

/// A transaction bound to one tenant. Repository functions accept nothing else.
pub struct TenantTx {
    tx: Transaction<'static, Postgres>,
    tenant: TenantId,
    // Set when the transaction came from a `ShopLock`: keeps the shop's place at the head of
    // the in-process queue until the transaction ends. Never read, only dropped.
    #[expect(dead_code, reason = "held for its Drop, which ends the shop's turn")]
    flight: Option<Flight>,
}

impl fmt::Debug for TenantTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TenantTx")
            .field("tenant", &self.tenant)
            .finish_non_exhaustive()
    }
}

impl TenantTx {
    /// The tenant every statement in this transaction is scoped to.
    #[must_use]
    pub const fn tenant_id(&self) -> TenantId {
        self.tenant
    }

    /// Commits the transaction.
    pub async fn commit(self) -> Result<(), DbError> {
        self.tx.commit().await?;
        Ok(())
    }

    /// Rolls the transaction back.
    pub async fn rollback(self) -> Result<(), DbError> {
        self.tx.rollback().await?;
        Ok(())
    }

    /// The connection, for repository functions in this crate only.
    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    /// The tenant as a UUID, for binding.
    pub(crate) const fn tenant_uuid(&self) -> uuid::Uuid {
        self.tenant.as_uuid()
    }
}
