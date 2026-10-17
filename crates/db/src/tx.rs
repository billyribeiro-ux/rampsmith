use std::fmt;

use domain::TenantId;
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
    /// Connects a pool. The URL's role must be an application role, never the owner.
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self, DbError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(url)
            .await?;
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
