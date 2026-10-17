//! The Rampsmith control-plane API (PLAN §6, ADR-001, ADR-005).
//!
//! Browsers never call it; the SvelteKit server does, over Railway's private network. Every
//! route is declared with `#[utoipa::path]` and registered through `OpenApiRouter`, so the
//! OpenAPI document and the router cannot disagree (ADR-009, ADR-020).

pub mod config;
mod health;

use axum::Router;
use db::Db;
use http_kit::{Limits, Problem, ProblemCode, with_middleware};
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

/// Shared state handed to every handler.
#[derive(Debug, Clone)]
pub struct AppState {
    db: Db,
    expected_schema: i64,
}

impl AppState {
    /// State for this build: ready once the database has this build's newest migration.
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self {
            db,
            expected_schema: db::expected_schema_version(),
        }
    }

    /// Overrides the schema version readiness waits for.
    #[must_use]
    pub const fn expecting_schema(mut self, version: i64) -> Self {
        self.expected_schema = version;
        self
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Rampsmith API",
        description = "Control-plane API behind the Rampsmith web app. Errors are RFC 9457 problem+json.",
        license(name = "Proprietary")
    ),
    components(schemas(Problem, ProblemCode)),
    tags((name = "operations", description = "Liveness and readiness for the platform"))
)]
struct ApiDoc;

fn routes() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(health::healthz))
        .routes(routes!(health::readyz))
}

/// The OpenAPI document, generated from the handlers.
#[must_use]
pub fn openapi() -> utoipa::openapi::OpenApi {
    routes().split_for_parts().1
}

/// The full application: routes, state and the standard middleware stack.
pub fn app(state: AppState) -> Router {
    let (router, _) = routes().split_for_parts();
    with_middleware(router.with_state(state), Limits::default())
}
