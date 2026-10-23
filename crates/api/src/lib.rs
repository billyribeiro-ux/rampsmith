//! The Rampsmith control-plane API (PLAN §6, ADR-001, ADR-005).
//!
//! Browsers never call it; the SvelteKit server does, over Railway's private network. Every
//! route is declared with `#[utoipa::path]` and registered through `OpenApiRouter`, so the
//! OpenAPI document and the router cannot disagree (ADR-009, ADR-020).

pub mod auth;
pub mod config;
pub mod email_link;
pub mod free_scan;
pub mod github_channel;
mod health;
pub mod plan;
mod r1;
pub mod rate_limit;
mod rules;
pub mod serve;
pub mod shopify;
pub mod webhooks;

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
    keys: Option<crypto::KeyRing>,
    partner: Option<plan::PartnerPlans>,
    free_scans: Option<free_scan::FreeScans>,
    github: Option<std::sync::Arc<github_channel::GithubChannel>>,
    email_links: Option<email_link::EmailLinks>,
    start_limiter: rate_limit::StartLimiter,
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
            keys: None,
            partner: None,
            free_scans: None,
            github: None,
            email_links: None,
            start_limiter: rate_limit::StartLimiter::default(),
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

    /// Gives the routes the master keys, to seal what merchants save (the storefront password).
    /// Without them, saving such a value answers 503.
    #[must_use]
    pub fn with_keys(mut self, keys: crypto::KeyRing) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Confirms plans with the Partner API (audit M3, ADR-084). Without it the routes serve the
    /// stored plan, which is Free until one is stored.
    #[must_use]
    pub fn with_partner(mut self, partner: plan::PartnerPlans) -> Self {
        self.partner = Some(partner);
        self
    }

    /// Enables the free scanner's anonymous scans (ADR-267). Without it its routes answer 503.
    #[must_use]
    pub fn with_free_scans(mut self, free_scans: free_scan::FreeScans) -> Self {
        self.free_scans = Some(free_scans);
        self
    }

    /// Switches the GitHub pull-request channel on (ADR-290). Without it the channel's routes
    /// answer 404.
    #[must_use]
    pub fn with_github(mut self, channel: github_channel::GithubChannel) -> Self {
        self.github = Some(std::sync::Arc::new(channel));
        self
    }

    /// Enables the pages behind email links (ADR-274). Without it their routes answer 503.
    #[must_use]
    pub fn with_email_links(mut self, links: email_link::EmailLinks) -> Self {
        self.email_links = Some(links);
        self
    }

    /// The email link keys, when configured.
    pub(crate) const fn email_links(&self) -> Option<&email_link::EmailLinks> {
        self.email_links.as_ref()
    }

    /// The free scanner, when configured.
    pub(crate) const fn free_scans(&self) -> Option<&free_scan::FreeScans> {
        self.free_scans.as_ref()
    }

    /// Replaces the limits on the unauthenticated passkey `start` endpoints (audit M6,
    /// ADR-042), for tests and for deployments that need other figures.
    #[must_use]
    pub fn with_start_limits(mut self, limits: rate_limit::StartLimits) -> Self {
        self.start_limiter = rate_limit::StartLimiter::new(limits);
        self
    }

    /// The limiter the `start` endpoints share.
    pub(crate) const fn start_limiter(&self) -> &rate_limit::StartLimiter {
        &self.start_limiter
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
        (name = "auth", description = "Standalone dashboard sign-in with passkeys"),
        (name = "free-scanner", description = "The marketing site's anonymous single-page scan (ADR-267)"),
        (name = "code-fixes", description = "The GitHub pull-request channel: connecting GitHub, choosing the theme repository (ADR-290)"),
        (name = "email", description = "The pages behind the unsubscribe and preferences links in email (ADR-274)"),
        (name = "app", description = "The embedded app's scans, findings, fixes, evidence, settings and statement")
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
        let mut service = Http::new(HttpAuthScheme::Bearer);
        service.description = Some(
            "`FREE_SCAN_SERVICE_TOKEN`: the secret the web server presents for the free scanner (ADR-267)."
                .to_owned(),
        );
        components.add_security_scheme("free_scan_service", SecurityScheme::Http(service));
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
        .routes(routes!(free_scan::create_free_scan))
        .routes(routes!(free_scan::get_free_scan))
        .routes(routes!(r1::get_overview))
        .routes(routes!(r1::start_scan))
        .routes(routes!(r1::get_scan))
        .routes(routes!(r1::list_findings))
        .routes(routes!(r1::get_finding))
        .routes(routes!(r1::list_fixes))
        .routes(routes!(r1::edit_fix))
        .routes(routes!(r1::approve_fix))
        .routes(routes!(r1::reject_fix))
        .routes(routes!(r1::undo_fix))
        .routes(routes!(r1::get_evidence))
        .routes(routes!(r1::get_settings, r1::update_settings))
        .routes(routes!(r1::get_statement, r1::save_statement))
        .routes(routes!(github_channel::get_code_fixes))
        .routes(routes!(
            github_channel::create_connection,
            github_channel::delete_connection
        ))
        .routes(routes!(github_channel::choose_repository))
        .routes(routes!(github_channel::finish_connection))
        .routes(routes!(email_link::inspect_link))
        .routes(routes!(email_link::change_link))
        .routes(routes!(
            email_link::get_email_preferences,
            email_link::update_email_preferences
        ))
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
