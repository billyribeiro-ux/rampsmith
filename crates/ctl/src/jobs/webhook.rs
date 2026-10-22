//! `webhook.process@1` (ADR-035, ADR-036). Stub: lane A (`r1-fixloop`) replaces the body of [`handle`].

use db::Db;
use queue::{ClaimedJob, Failure};

/// Handles one `webhook.process@1` job.
#[expect(
    clippy::unused_async,
    reason = "a stub: lane A's handler awaits the database and Shopify, and removes this attribute"
)]
pub async fn handle(_db: &Db, job: ClaimedJob) -> Result<(), Failure> {
    Err(super::not_implemented(&job))
}
