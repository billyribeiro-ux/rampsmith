//! Enqueuing jobs in the same transaction as the domain write that causes them (PLAN §10).

use queue::{Enqueued, NewJob};

use crate::{DbError, TenantTx};

/// Enqueues `job` for the transaction's tenant. The job commits or rolls back with the
/// rest of the transaction; workers are notified on commit. Any `tenant_id` already on the
/// job is replaced by the transaction's tenant.
pub async fn enqueue(tx: &mut TenantTx, job: NewJob) -> Result<Enqueued, DbError> {
    let job = job.for_tenant(tx.tenant_uuid());
    queue::enqueue(tx.conn(), &job)
        .await
        .map_err(|error| match error {
            queue::QueueError::Database(e) => DbError::from(e),
            other => DbError::Queue(other.to_string()),
        })
}

/// Cancels the tenant's jobs that have not started, except those of `keep_queue` and the
/// `email.send` queue. After `app/uninstalled` the scans, reads and fixes in line must not run,
/// but a compliance webhook waiting in `webhook.process` must (PLAN §19), which is why
/// `queue::cancel_tenant_jobs` is not used. Email must too: the uninstall's own export mail is
/// queued in that transaction, and a repeated `app/uninstalled` would otherwise cancel it before
/// it was sent (ADR-277, audit L1). Returns how many were cancelled.
pub async fn cancel_pending(tx: &mut TenantTx, keep_queue: &str) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update jobs set state = 'cancelled', finished_at = now()
            where tenant_id = $1 and state = 'ready' and queue <> $2 and queue <> 'email.send'"#,
        tenant,
        keep_queue,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}
