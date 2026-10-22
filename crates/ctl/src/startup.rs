//! Startup checks (audit M4, ADR-040).
//!
//! `ctl` claims jobs across tenants, so it must never run as a role that row-level security
//! cannot bind. Unlike the api it has no readiness endpoint to repeat the check, so it
//! verifies once before it starts any worker or the leader loop.

use std::time::Duration;

use db::{Db, RoleError, RuntimeRole};
use tracing::warn;

/// Waits until the database confirms the pool is connected as a plain `LOGIN` member of
/// `rampsmith_worker`. Returns `Ok(true)` then, `Ok(false)` if `shutdown` resolved first, and
/// an error as soon as the database answers that the role is unfit: that is a configuration
/// mistake no retry fixes. An unreachable database is retried every `retry_every`, so a
/// deploy that starts before the database does not crash-loop.
pub async fn require_worker_role(
    db: &Db,
    retry_every: Duration,
    shutdown: impl Future<Output = ()>,
) -> Result<bool, RoleError> {
    tokio::pin!(shutdown);
    loop {
        match db.verify_runtime_role(RuntimeRole::Worker).await {
            Ok(()) => return Ok(true),
            Err(refused @ RoleError::Refused { .. }) => return Err(refused),
            Err(RoleError::Unreachable(error)) => {
                warn!(%error, "cannot check the database role yet; retrying");
            }
        }
        tokio::select! {
            () = &mut shutdown => return Ok(false),
            () = tokio::time::sleep(retry_every) => {}
        }
    }
}
