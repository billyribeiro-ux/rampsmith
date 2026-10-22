//! The R1 queues `ctl` serves besides `shopify.token_refresh` (ADR-035, ADR-038).
//!
//! Every handler is a stub for now: it answers with a typed permanent failure,
//! [`not_implemented`], so a job that reaches it is parked as dead with a reason instead of
//! being retried or silently dropped. Nothing enqueues these jobs before the fix-loop lane (A)
//! does, so no job is parked in practice. Lane A replaces one stub at a time by editing that
//! queue's own module; this registry does not change.

use contracts::{
    JobError, ShopifyApplyDataFix, ShopifyReadStore, ShopifyRevertDataFix, WebhookProcess,
};
use db::Db;
use queue::{ClaimedJob, Failure};

pub mod apply_data_fix;
pub mod read_store;
pub mod revert_data_fix;
pub mod webhook;

/// The queues this registry serves.
pub const QUEUES: [&str; 4] = [
    ShopifyReadStore::QUEUE,
    ShopifyApplyDataFix::QUEUE,
    ShopifyRevertDataFix::QUEUE,
    WebhookProcess::QUEUE,
];

/// The `code` of the failure a stub returns.
pub const NOT_IMPLEMENTED: &str = "not_implemented";

/// The typed outcome of a stub: a permanent failure that names the queue.
#[must_use]
pub fn not_implemented(job: &ClaimedJob) -> Failure {
    Failure::Permanent(JobError {
        code: NOT_IMPLEMENTED.to_owned(),
        message: format!("{} is not implemented yet", job.queue),
        retryable: false,
    })
}

/// Hands `job` to its queue's handler. The queue is the one the worker claimed from, so a
/// queue outside [`QUEUES`] is a wiring mistake and fails permanently.
pub async fn dispatch(db: &Db, job: ClaimedJob) -> Result<(), Failure> {
    match job.queue.as_str() {
        ShopifyReadStore::QUEUE => read_store::handle(db, job).await,
        ShopifyApplyDataFix::QUEUE => apply_data_fix::handle(db, job).await,
        ShopifyRevertDataFix::QUEUE => revert_data_fix::handle(db, job).await,
        WebhookProcess::QUEUE => webhook::handle(db, job).await,
        other => Err(Failure::Permanent(JobError {
            code: "queue_unknown".to_owned(),
            message: format!("ctl does not serve {other}"),
            retryable: false,
        })),
    }
}
