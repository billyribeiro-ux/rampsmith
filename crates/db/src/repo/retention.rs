//! The sweeps the leader runs for data that expires on its own clock (ADR-035, ADR-267). Each
//! calls a function that only the worker role may execute and whose ages are fixed in the
//! migration, so no caller chooses what is deleted.

use crate::{DbError, PublicTx};

/// Deletes store data read for scans more than 30 days ago, for every tenant (ADR-035); returns
/// how many rows went.
pub async fn scan_inputs(tx: &mut PublicTx) -> Result<i64, DbError> {
    Ok(
        sqlx::query_scalar!(r#"select scan_inputs_sweep() as "swept!""#)
            .fetch_one(tx.conn())
            .await?,
    )
}

/// Deletes the email data that outlived its purpose: contacts of shops uninstalled for 30 days
/// whose `shop/redact` never came, and delivery records not touched for 90 days (audit L5,
/// ADR-277). Returns how many rows went.
pub async fn email_records(tx: &mut PublicTx) -> Result<i64, DbError> {
    Ok(
        sqlx::query_scalar!(r#"select email_records_sweep() as "swept!""#)
            .fetch_one(tx.conn())
            .await?,
    )
}

/// Ends free scans the engine never finished and deletes expired ones (ADR-267); returns how
/// many it deleted.
pub async fn free_scans(tx: &mut PublicTx) -> Result<i64, DbError> {
    crate::repo::free_scans::sweep(tx).await
}

/// Clears sealed storefront-password copies more than an hour old, for every tenant (audit M3,
/// ADR-283): the backstop for a scan that ended by a path that forgot its copy. Returns how
/// many it cleared.
pub async fn scan_passwords(tx: &mut PublicTx) -> Result<i64, DbError> {
    Ok(
        sqlx::query_scalar!(r#"select scan_passwords_sweep() as "cleared!""#)
            .fetch_one(tx.conn())
            .await?,
    )
}
