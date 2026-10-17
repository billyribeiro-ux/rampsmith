//! PostgreSQL access for Rampsmith (PLAN §9, ADR-006).
//!
//! Every tenant-owned row is reached through a [`TenantTx`]: a transaction that has set
//! `app.tenant_id`, so row-level security applies to everything inside it. Repository
//! functions in [`repo`] accept only `&mut TenantTx` and also filter by its tenant, so
//! unscoped access does not compile and a missed filter still cannot leak across tenants.
//! [`Db`] never hands out its pool.

mod error;
pub mod repo;
mod tx;

pub use error::DbError;
pub use tx::{Db, TenantTx};

/// The workspace migrations, embedded at compile time. Deploys run them before traffic
/// switches (PLAN §22); tests get them applied by `#[sqlx::test]`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();
