//! `shopify.read_store@1` (ADR-035, ADR-036). Stub: replaced in the next increment.

use queue::{ClaimedJob, Failure};

use super::Jobs;

/// Handles one `shopify.read_store@1` job.
#[expect(clippy::unused_async, reason = "a stub until the store read lands")]
pub async fn handle(_jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    Err(super::not_implemented(&job))
}
