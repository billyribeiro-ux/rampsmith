//! Shopify session authentication for embedded-app requests (PLAN §14, ADR-022).
//!
//! `web` forwards the App Bridge session token it received as `Authorization: Bearer`.
//! [`ShopSession`] is the extractor every embedded route uses; `POST /v1/shopify/session`
//! is the first call the embedded app makes, which installs the app on first use.

use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderName, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use http_kit::{ApiError, ProblemCode};
use serde::Serialize;
use shopify_auth::AuthError;
use tracing::{error, warn};
use utoipa::ToSchema;

use crate::AppState;

/// Tells App Bridge to fetch a fresh session token and retry the request once
/// (shopify.dev, "Authenticate an embedded app without a template").
pub const RETRY_HEADER: HeaderName =
    HeaderName::from_static("x-shopify-retry-invalid-session-request");

/// A request authenticated by a Shopify session token.
#[derive(Debug, Clone)]
pub struct ShopSession(pub shopify_auth::ShopSession);

/// Why a Shopify-authenticated request was refused.
#[derive(Debug)]
pub struct SessionRejection {
    error: ApiError,
    retry: bool,
}

impl IntoResponse for SessionRejection {
    fn into_response(self) -> Response {
        let mut response = self.error.into_response();
        if self.retry {
            response
                .headers_mut()
                .insert(RETRY_HEADER, HeaderValue::from_static("1"));
        }
        response
    }
}

fn unauthenticated() -> SessionRejection {
    SessionRejection {
        error: ApiError::new(ProblemCode::Unauthenticated)
            .detail("The Shopify session token is missing, invalid or expired."),
        retry: true,
    }
}

impl From<AuthError> for SessionRejection {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::InvalidSessionToken(reason) => {
                warn!(%reason, "rejected a Shopify session token");
                unauthenticated()
            }
            AuthError::StaleSessionToken => {
                warn!("Shopify rejected the session token in exchange");
                unauthenticated()
            }
            AuthError::Unavailable(reason) => {
                warn!(%reason, "Shopify token exchange unavailable");
                Self {
                    error: ApiError::new(ProblemCode::UpstreamFailed)
                        .detail("Shopify is not answering; try again shortly."),
                    retry: false,
                }
            }
            AuthError::Exchange(reason) => {
                error!(%reason, "token exchange failed: check SHOPIFY_API_KEY and SHOPIFY_API_SECRET");
                Self {
                    error: ApiError::new(ProblemCode::Internal),
                    retry: false,
                }
            }
            AuthError::Database(e) => Self {
                error: e.into(),
                retry: false,
            },
            AuthError::Crypto(reason) => {
                error!(%reason, "sealing or opening Shopify tokens failed");
                Self {
                    error: ApiError::new(ProblemCode::Internal),
                    retry: false,
                }
            }
        }
    }
}

fn bearer(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

impl FromRequestParts<AppState> for ShopSession {
    type Rejection = SessionRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or_else(unauthenticated)?;
        let auth = state.shopify.as_ref().ok_or_else(|| SessionRejection {
            error: ApiError::new(ProblemCode::Unavailable)
                .detail("Shopify authentication is not configured."),
            retry: false,
        })?;
        Ok(Self(auth.authenticate(token).await?))
    }
}

/// The shop a session belongs to.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionInfo {
    /// The shop's `*.myshopify.com` domain.
    shop: String,
    /// Whether this request installed (or reinstalled) the app.
    installed: bool,
}

/// Starts an embedded-app session: verifies the Shopify session token and, on first use,
/// installs the app by token exchange.
#[utoipa::path(
    post,
    path = "/v1/shopify/session",
    tag = "shopify",
    operation_id = "createShopifySession",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "Authenticated", body = SessionInfo),
        (status = UNAUTHORIZED, description = "Missing, invalid or stale session token; \
            the response carries `X-Shopify-Retry-Invalid-Session-Request: 1`",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = BAD_GATEWAY, description = "Shopify did not answer token exchange",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = SERVICE_UNAVAILABLE, description = "Shopify authentication is not configured",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_session(
    State(_): State<AppState>,
    ShopSession(session): ShopSession,
) -> Json<SessionInfo> {
    Json(SessionInfo {
        shop: session.shop.as_str().to_owned(),
        installed: session.installed,
    })
}
