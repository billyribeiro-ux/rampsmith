//! The Rampsmith control-plane API (PLAN §6, ADR-001, ADR-005).
//!
//! Browsers never call it; the SvelteKit server does, over Railway's private network. Every
//! route is declared with `#[utoipa::path]` and registered through `OpenApiRouter`, so the
//! OpenAPI document and the router cannot disagree (ADR-009, ADR-020).

pub mod auth;
pub mod config;
mod health;
pub mod shopify;

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
    shopify: Option<shopify_auth::ShopifyAuth>,
    identity: Option<identity::Identity>,
}

impl AppState {
    /// State for this build: ready once the database has this build's newest migration.
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self {
            db,
            expected_schema: db::expected_schema_version(),
            shopify: None,
            identity: None,
        }
    }

    /// Enables dashboard sign-in with passkeys. Without it, auth routes answer 503.
    #[must_use]
    pub fn with_identity(mut self, identity: identity::Identity) -> Self {
        self.identity = Some(identity);
        self
    }

    /// Enables Shopify session authentication. Without it, Shopify routes answer 503.
    #[must_use]
    pub fn with_shopify(mut self, auth: shopify_auth::ShopifyAuth) -> Self {
        self.shopify = Some(auth);
        self
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
    modifiers(&SecuritySchemes),
    tags(
        (name = "operations", description = "Liveness and readiness for the platform"),
        (name = "shopify", description = "The embedded Shopify app's session"),
        (name = "auth", description = "Standalone dashboard sign-in with passkeys")
    )
)]
struct ApiDoc;

struct SecuritySchemes;

impl utoipa::Modify for SecuritySchemes {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
        let components = openapi.components.get_or_insert_with(Default::default);
        let mut scheme = Http::new(HttpAuthScheme::Bearer);
        scheme.bearer_format = Some("JWT".to_owned());
        scheme.description = Some(
            "The App Bridge session (ID) token, forwarded by the web app (ADR-022).".to_owned(),
        );
        components.add_security_scheme("shopify_session", SecurityScheme::Http(scheme));
        let mut session = utoipa::openapi::security::ApiKeyValue::new("Authorization");
        session.description = Some(
            "`Session <token>`: the dashboard session token, forwarded by the web app (ADR-024)."
                .to_owned(),
        );
        components.add_security_scheme(
            "dashboard_session",
            SecurityScheme::ApiKey(utoipa::openapi::security::ApiKey::Header(session)),
        );
    }
}

fn routes() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(health::healthz))
        .routes(routes!(health::readyz))
        .routes(routes!(shopify::create_session))
        .routes(routes!(auth::start_registration))
        .routes(routes!(auth::finish_registration))
        .routes(routes!(auth::start_sign_in))
        .routes(routes!(auth::finish_sign_in))
        .routes(routes!(auth::get_session, auth::delete_session))
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
