//! Standalone-dashboard sign-in with passkeys (PLAN §16, ADR-024).
//!
//! `web` calls these on the browser's behalf: it relays the WebAuthn options and responses,
//! keeps the session token in an `HttpOnly` cookie, and forwards it as
//! `Authorization: Session <token>`. [`UserSession`] is the extractor dashboard routes use.

use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use http_kit::{ApiError, ProblemCode};
use identity::{IdentityError, NewSession, User};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use tracing::error;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;

fn identity_of(state: &AppState) -> Result<&identity::Identity, ApiError> {
    state.identity.as_ref().ok_or_else(|| {
        ApiError::new(ProblemCode::Unavailable).detail("Dashboard sign-in is not configured.")
    })
}

fn rejected() -> ApiError {
    // One answer for every verification failure, so responses reveal nothing about why.
    ApiError::new(ProblemCode::BadRequest).detail("The passkey could not be verified. Try again.")
}

fn identity_error(e: IdentityError) -> ApiError {
    match e {
        IdentityError::InvalidInput(field) => ApiError::new(ProblemCode::ValidationFailed)
            .detail(format!("The {field} is not valid.")),
        IdentityError::EmailTaken => ApiError::new(ProblemCode::Conflict)
            .detail("An account already uses this email. Sign in instead."),
        IdentityError::CeremonyNotFound | IdentityError::Rejected => rejected(),
        IdentityError::Database(e) => e.into(),
        IdentityError::Config(reason) => {
            error!(%reason, "WebAuthn configuration error");
            ApiError::new(ProblemCode::Internal)
        }
        IdentityError::Corrupt => {
            error!("stored WebAuthn state is corrupt");
            ApiError::new(ProblemCode::Internal)
        }
    }
}

/// A dashboard user, as the web app shows them.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct UserInfo {
    /// The user's id.
    id: Uuid,
    /// Their email address.
    email: String,
    /// Their display name.
    display_name: String,
}

impl From<User> for UserInfo {
    fn from(u: User) -> Self {
        Self {
            id: u.id.as_uuid(),
            email: u.email,
            display_name: u.display_name,
        }
    }
}

/// Options for `navigator.credentials`, and the ceremony they belong to.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CeremonyStarted {
    /// Echo this in the matching `finish` call.
    ceremony_id: Uuid,
    /// WebAuthn options in their JSON form (`publicKey` and, for sign-in, `mediation`).
    #[schema(value_type = Object)]
    options: Value,
}

/// A new session. The token is shown once; store it in an `HttpOnly` cookie.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionCreated {
    /// The session token.
    token: String,
    /// When the session ends regardless of use.
    #[serde(with = "time::serde::rfc3339")]
    #[schema(value_type = String, format = DateTime)]
    expires_at: OffsetDateTime,
    /// Who signed in.
    user: UserInfo,
}

impl From<NewSession> for SessionCreated {
    fn from(s: NewSession) -> Self {
        Self {
            token: s.token.expose_secret().to_owned(),
            expires_at: s.expires_at,
            user: s.user.into(),
        }
    }
}

/// Starts a registration.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct RegistrationRequest {
    /// The account's email address.
    email: String,
    /// The name to show in the dashboard.
    display_name: String,
}

/// Completes a ceremony with the browser's answer.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct CeremonyResponse {
    /// From the matching `start` call.
    ceremony_id: Uuid,
    /// `PublicKeyCredential.toJSON()` from the browser.
    #[schema(value_type = Object)]
    credential: Value,
}

fn json_body<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|_| rejected())
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|_| ApiError::new(ProblemCode::Internal))
}

/// Starts registering an account and its first passkey.
#[utoipa::path(
    post,
    path = "/v1/auth/register/start",
    tag = "auth",
    operation_id = "startRegistration",
    request_body = RegistrationRequest,
    responses(
        (status = OK, body = CeremonyStarted),
        (status = CONFLICT, description = "The email is taken", body = http_kit::Problem,
            content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, body = http_kit::Problem,
            content_type = "application/problem+json")
    )
)]
pub(crate) async fn start_registration(
    State(state): State<AppState>,
    Json(request): Json<RegistrationRequest>,
) -> Result<Json<CeremonyStarted>, ApiError> {
    let (ceremony_id, options) = identity_of(&state)?
        .start_registration(
            &request.email,
            &request.display_name,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(identity_error)?;
    Ok(Json(CeremonyStarted {
        ceremony_id,
        options: to_value(&options)?,
    }))
}

/// Completes a registration and signs the new user in.
#[utoipa::path(
    post,
    path = "/v1/auth/register/finish",
    tag = "auth",
    operation_id = "finishRegistration",
    request_body = CeremonyResponse,
    responses(
        (status = CREATED, body = SessionCreated),
        (status = BAD_REQUEST, description = "The passkey did not verify", body = http_kit::Problem,
            content_type = "application/problem+json"),
        (status = CONFLICT, description = "The email was taken meanwhile", body = http_kit::Problem,
            content_type = "application/problem+json")
    )
)]
pub(crate) async fn finish_registration(
    State(state): State<AppState>,
    Json(request): Json<CeremonyResponse>,
) -> Result<(StatusCode, Json<SessionCreated>), ApiError> {
    let credential = json_body(request.credential)?;
    let session = identity_of(&state)?
        .finish_registration(request.ceremony_id, &credential, OffsetDateTime::now_utc())
        .await
        .map_err(identity_error)?;
    Ok((StatusCode::CREATED, Json(session.into())))
}

/// Starts a passkey sign-in. No email: the browser offers the passkeys it holds for this site.
#[utoipa::path(
    post,
    path = "/v1/auth/sign-in/start",
    tag = "auth",
    operation_id = "startSignIn",
    responses((status = OK, body = CeremonyStarted))
)]
pub(crate) async fn start_sign_in(
    State(state): State<AppState>,
) -> Result<Json<CeremonyStarted>, ApiError> {
    let (ceremony_id, options) = identity_of(&state)?
        .start_sign_in(OffsetDateTime::now_utc())
        .await
        .map_err(identity_error)?;
    Ok(Json(CeremonyStarted {
        ceremony_id,
        options: to_value(&options)?,
    }))
}

/// Completes a passkey sign-in.
#[utoipa::path(
    post,
    path = "/v1/auth/sign-in/finish",
    tag = "auth",
    operation_id = "finishSignIn",
    request_body = CeremonyResponse,
    responses(
        (status = CREATED, body = SessionCreated),
        (status = BAD_REQUEST, description = "The passkey did not verify", body = http_kit::Problem,
            content_type = "application/problem+json")
    )
)]
pub(crate) async fn finish_sign_in(
    State(state): State<AppState>,
    Json(request): Json<CeremonyResponse>,
) -> Result<(StatusCode, Json<SessionCreated>), ApiError> {
    let credential = json_body(request.credential)?;
    let session = identity_of(&state)?
        .finish_sign_in(request.ceremony_id, &credential, OffsetDateTime::now_utc())
        .await
        .map_err(identity_error)?;
    Ok((StatusCode::CREATED, Json(session.into())))
}

/// A request from a signed-in dashboard user (`Authorization: Session <token>`).
#[derive(Debug)]
pub struct UserSession {
    /// The user.
    pub user: User,
    token: SecretString,
}

fn session_token(parts: &Parts) -> Option<SecretString> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("session") && !token.is_empty() && token.len() <= 128)
        .then(|| SecretString::from(token.to_owned()))
}

impl FromRequestParts<AppState> for UserSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let unauthenticated =
            || ApiError::new(ProblemCode::Unauthenticated).detail("Sign in to continue.");
        let token = session_token(parts).ok_or_else(unauthenticated)?;
        let user = identity_of(state)?
            .session(&token, OffsetDateTime::now_utc())
            .await
            .map_err(identity_error)?
            .ok_or_else(unauthenticated)?;
        Ok(Self { user, token })
    }
}

/// Wraps the signed-in user.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionInfo {
    /// Who is signed in.
    user: UserInfo,
}

/// The signed-in user; also extends the session's idle expiry.
#[utoipa::path(
    get,
    path = "/v1/auth/session",
    tag = "auth",
    operation_id = "getSession",
    security(("dashboard_session" = [])),
    responses(
        (status = OK, body = SessionInfo),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_session(session: UserSession) -> Json<SessionInfo> {
    Json(SessionInfo {
        user: session.user.into(),
    })
}

/// Signs out: the session token stops working.
#[utoipa::path(
    delete,
    path = "/v1/auth/session",
    tag = "auth",
    operation_id = "deleteSession",
    security(("dashboard_session" = [])),
    responses(
        (status = NO_CONTENT, description = "Signed out"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn delete_session(
    State(state): State<AppState>,
    session: UserSession,
) -> Result<impl IntoResponse, ApiError> {
    identity_of(&state)?
        .sign_out(&session.token)
        .await
        .map_err(identity_error)?;
    Ok(StatusCode::NO_CONTENT)
}
