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
