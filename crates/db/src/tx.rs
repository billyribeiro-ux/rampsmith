use std::fmt;

use domain::{ShopId, ShopStatus, TenantId};
use sqlx::postgres::{PgConnection, PgPool, PgPoolOptions};
use sqlx::{Postgres, Transaction};

use crate::DbError;

/// A handle to the database that only opens tenant-scoped transactions.
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
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
            .acquire_timeout(std::time::Duration::from_secs(5))
            .connect_lazy(url)?;
        Ok(Self { pool })
    }

    /// Wraps an existing pool, for binaries and tests that configure their own.
    #[must_use]
    pub const fn from_pool(pool: PgPool) -> Self {
        Self { pool }
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
        Ok(TenantTx { tx, tenant })
    }

    /// Checks the database answers, without touching tenant data.
    pub async fn ping(&self) -> Result<(), DbError> {
        sqlx::query!("select 1 as one")
            .fetch_one(&self.pool)
            .await?;
        Ok(())
    }

    /// The tenant and shop for a shop domain, across tenants (ADR-022). Call it only after
    /// verifying a Shopify session token or webhook signature for that domain.
    pub async fn shop_by_domain(&self, shop_domain: &str) -> Result<Option<ShopRef>, DbError> {
        let row = sqlx::query!(
            r#"select tenant_id as "tenant_id!", shop_id as "shop_id!", status as "status!"
                 from app_shop_by_domain($1)"#,
            shop_domain
        )
        .fetch_optional(&self.pool)
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

    /// Serialises token exchange and refresh for one shop across every process (ADR-022):
    /// waits for, then holds, a transaction-scoped advisory lock until the guard is released
    /// or dropped. The guard touches no table.
    pub async fn shop_lock(&self, shop_domain: &str) -> Result<ShopLock, DbError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query!(
            "select pg_advisory_xact_lock(hashtextextended('shopify.shop:' || $1, 0))",
            shop_domain
        )
        .fetch_one(&mut *tx)
        .await?;
        Ok(ShopLock { tx })
    }

    /// The newest migration applied to this database, or `None` before any.
    pub async fn schema_version(&self) -> Result<Option<i64>, DbError> {
        Ok(sqlx::query_scalar!("select app_schema_version()")
            .fetch_one(&self.pool)
            .await?)
    }
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

/// Holds a shop's token lock; see [`Db::shop_lock`].
pub struct ShopLock {
    tx: Transaction<'static, Postgres>,
}

impl fmt::Debug for ShopLock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ShopLock").finish_non_exhaustive()
    }
}

impl ShopLock {
    /// Releases the lock.
    pub async fn release(self) -> Result<(), DbError> {
        self.tx.commit().await?;
        Ok(())
    }
}

/// A transaction bound to one tenant. Repository functions accept nothing else.
pub struct TenantTx {
    tx: Transaction<'static, Postgres>,
    tenant: TenantId,
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
