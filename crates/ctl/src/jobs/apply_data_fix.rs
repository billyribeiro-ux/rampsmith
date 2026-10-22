//! `shopify.apply_data_fix@1` (ADR-035, ADR-036). Stub: replaced in the next increment.

use queue::{ClaimedJob, Failure};

use super::Jobs;

/// Handles one `shopify.apply_data_fix@1` job.
#[expect(clippy::unused_async, reason = "a stub until the data-fix apply lands")]
pub async fn handle(_jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    Err(super::not_implemented(&job))
}
