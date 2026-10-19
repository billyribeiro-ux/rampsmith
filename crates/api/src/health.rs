//! Liveness and readiness (PLAN §22): `/healthz` for the platform's liveness probe,
//! `/readyz` before traffic switches to a new deploy.

use axum::Json;
use axum::extract::State;
use db::{RoleError, RuntimeRole};
use http_kit::{ApiError, ProblemCode};
use serde::Serialize;
use tracing::{error, warn};
use utoipa::ToSchema;

use crate::AppState;

/// The process is up.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Health {
    /// Always `ok`.
    status: &'static str,
}

/// The process can serve: the database answers and has this build's migrations.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Readiness {
    /// Always `ready`.
    status: &'static str,
    /// The newest migration applied to the database.
    schema_version: i64,
    /// The newest migration this build knows.
    expected_schema_version: i64,
}

/// Liveness: answers as long as the process runs. Never touches dependencies, so a slow
/// database cannot get a healthy process restarted.
#[utoipa::path(
    get,
    path = "/healthz",
    tag = "operations",
    operation_id = "healthz",
    responses((status = OK, description = "The process is up", body = Health))
)]
pub(crate) async fn healthz() -> Json<Health> {
    Json(Health { status: "ok" })
}

/// Readiness: the database answers, the connection is a plain application login that
/// row-level security binds (ADR-040), and the database holds at least this build's newest
/// migration.
#[utoipa::path(
    get,
    path = "/readyz",
    tag = "operations",
    operation_id = "readyz",
    responses(
        (status = OK, description = "Ready to serve", body = Readiness),
        (status = SERVICE_UNAVAILABLE, description = "Not ready", body = http_kit::Problem,
            content_type = "application/problem+json")
    )
)]
pub(crate) async fn readyz(State(state): State<AppState>) -> Result<Json<Readiness>, ApiError> {
    let unavailable = |why: &str| ApiError::new(ProblemCode::Unavailable).detail(why.to_owned());
    match state.db.verify_runtime_role(RuntimeRole::App).await {
        Ok(()) => {}
        Err(refused @ RoleError::Refused { .. }) => {
            // The role and what is wrong with it are for the operator, not the caller.
            error!(%refused, "readiness: the database login is not fit to serve tenants");
            return Err(unavailable("The database role is not an application role."));
        }
        Err(RoleError::Unreachable(error)) => {
            warn!(%error, "readiness: database unavailable");
            return Err(unavailable("The database is not reachable."));
        }
    }
    let applied = match state.db.schema_version().await {
        Ok(version) => version.unwrap_or(0),
        Err(error) => {
            warn!(%error, "readiness: database unavailable");
            return Err(unavailable("The database is not reachable."));
        }
    };
    if applied < state.expected_schema {
        warn!(
            applied,
            expected = state.expected_schema,
            "readiness: migrations are behind this build"
        );
        return Err(unavailable("Database migrations are behind this build."));
    }
    Ok(Json(Readiness {
        status: "ready",
        schema_version: applied,
        expected_schema_version: state.expected_schema,
    }))
}
