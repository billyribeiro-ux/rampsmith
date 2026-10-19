//! Dashboard sign-in over HTTP (ADR-024), with a software passkey as the browser.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use api::AppState;
use api::rate_limit::{Rate, StartLimits};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use db::Db;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::prelude::{
    CreationChallengeResponse, RequestChallengeResponse, Url,
};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

mod support;

use support::app_login_pool;

const ORIGIN: &str = "https://app.rampsmith.test";

async fn state(opts: PgPoolOptions, conn: PgConnectOptions) -> AppState {
    let pool = app_login_pool(opts, conn).await;
    let db = Db::from_pool(pool);
    let identity =
        identity::Identity::new(db.clone(), "app.rampsmith.test", ORIGIN, "Rampsmith").unwrap();
    AppState::new(db).with_identity(identity)
}

async fn call(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<Value>,
    session: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = session {
        request = request.header(header::AUTHORIZATION, format!("Session {token}"));
    }
    let request = match body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap();
    let response = api::app(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The software key cannot store resident credentials, so it is shown options that do not ask
/// for one. The server's options (and its verification) are unchanged.
fn soft(options: CreationChallengeResponse) -> CreationChallengeResponse {
    let mut value = serde_json::to_value(options).unwrap();
    value["publicKey"]["authenticatorSelection"]["residentKey"] = json!("discouraged");
    value["publicKey"]["authenticatorSelection"]["requireResidentKey"] = json!(false);
    serde_json::from_value(value).unwrap()
}

fn key() -> WebauthnAuthenticator<SoftPasskey> {
    WebauthnAuthenticator::new(SoftPasskey::new(true))
}

/// Registers through the API; returns the session body and the credential id.
async fn register(
    state: &AppState,
    key: &mut WebauthnAuthenticator<SoftPasskey>,
    email: &str,
) -> (Value, String) {
    let (status, started) = call(
        state,
        Method::POST,
        "/v1/auth/register/start",
        Some(json!({"email": email, "display_name": "Ada"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let options: CreationChallengeResponse =
        serde_json::from_value(started["options"].clone()).unwrap();
    let credential = key
        .do_registration(Url::parse(ORIGIN).unwrap(), soft(options))
        .unwrap();
    let credential = serde_json::to_value(credential).unwrap();
    let id = credential["id"].as_str().unwrap().to_owned();
    let (status, session) = call(
        state,
        Method::POST,
        "/v1/auth/register/finish",
        Some(json!({"ceremony_id": started["ceremony_id"], "credential": credential})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{session}");
    (session, id)
}

#[sqlx::test(migrations = "../db/migrations")]
async fn register_use_sign_out_and_sign_in_again(opts: PgPoolOptions, conn: PgConnectOptions) {
    let state = state(opts, conn).await;
    let mut key = key();
    let (session, credential_id) = register(&state, &mut key, "ada@example.com").await;
    assert_eq!(session["user"]["email"], "ada@example.com");
    assert!(session["expires_at"].as_str().unwrap().ends_with('Z'));
    let token = session["token"].as_str().unwrap().to_owned();

    let (status, me) = call(&state, Method::GET, "/v1/auth/session", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["user"]["display_name"], "Ada");

    let (status, _) = call(
        &state,
        Method::DELETE,
        "/v1/auth/session",
        None,
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, problem) = call(&state, Method::GET, "/v1/auth/session", None, Some(&token)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(problem["code"], "unauthenticated");

    // Discoverable sign-in: no email is sent.
    let (status, started) = call(&state, Method::POST, "/v1/auth/sign-in/start", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(started["options"]["mediation"], "conditional");
    let mut options = started["options"].clone();
    options["publicKey"]["allowCredentials"] = json!([{"type": "public-key", "id": credential_id}]);
    let options: RequestChallengeResponse = serde_json::from_value(options).unwrap();
    let assertion = key
        .do_authentication(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let mut assertion = serde_json::to_value(assertion).unwrap();
    let user_id: uuid::Uuid = session["user"]["id"].as_str().unwrap().parse().unwrap();
    assertion["response"]["userHandle"] = json!(URL_SAFE_NO_PAD.encode(user_id.as_bytes()));
    let (status, signed_in) = call(
        &state,
        Method::POST,
        "/v1/auth/sign-in/finish",
        Some(json!({"ceremony_id": started["ceremony_id"], "credential": assertion})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{signed_in}");
    assert_eq!(signed_in["user"]["id"], session["user"]["id"]);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn verification_failures_all_look_the_same(opts: PgPoolOptions, conn: PgConnectOptions) {
    let state = state(opts, conn).await;
    let (_, started) = call(
        &state,
        Method::POST,
        "/v1/auth/register/start",
        Some(json!({"email": "ada@example.com", "display_name": "Ada"})),
        None,
    )
    .await;
    let unknown = uuid::Uuid::now_v7();
    let mut details = vec![];
    for body in [
        json!({"ceremony_id": started["ceremony_id"], "credential": {"nonsense": true}}),
        json!({"ceremony_id": unknown, "credential": {}}),
    ] {
        let (status, problem) = call(
            &state,
            Method::POST,
            "/v1/auth/register/finish",
            Some(body),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{problem}");
        details.push(problem["detail"].clone());
    }
    assert_eq!(details[0], details[1]);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn registration_input_and_conflicts_are_reported(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let state = state(opts, conn).await;
    let mut key = key();
    register(&state, &mut key, "ada@example.com").await;
    let (status, problem) = call(
        &state,
        Method::POST,
        "/v1/auth/register/start",
        Some(json!({"email": "Ada@Example.com", "display_name": "Ada"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["code"], "conflict");
    let (status, problem) = call(
        &state,
        Method::POST,
        "/v1/auth/register/start",
        Some(json!({"email": "nope", "display_name": "Ada"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], "validation_failed");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn session_routes_need_a_session_token(opts: PgPoolOptions, conn: PgConnectOptions) {
    let state = state(opts, conn).await;
    for session in [None, Some("bogus")] {
        let (status, _) = call(&state, Method::GET, "/v1/auth/session", None, session).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{session:?}");
        let (status, _) = call(&state, Method::DELETE, "/v1/auth/session", None, session).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{session:?}");
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_identity_configured_auth_is_unavailable(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let state = AppState::new(Db::from_pool(app_login_pool(opts, conn).await));
    let (status, _) = call(&state, Method::POST, "/v1/auth/sign-in/start", None, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn the_openapi_document_declares_the_auth_routes() {
    let doc = serde_json::to_value(api::openapi()).unwrap();
    for (path, method) in [
        ("/v1/auth/register/start", "post"),
        ("/v1/auth/register/finish", "post"),
        ("/v1/auth/sign-in/start", "post"),
        ("/v1/auth/sign-in/finish", "post"),
        ("/v1/auth/session", "get"),
        ("/v1/auth/session", "delete"),
    ] {
        assert!(doc["paths"][path][method].is_object(), "{method} {path}");
    }
    assert_eq!(
        doc["components"]["securitySchemes"]["dashboard_session"]["in"],
        "header"
    );
}

// --- Rate limits on the unauthenticated start endpoints (audit M6, ADR-042) --------------------

const HOUR: Duration = Duration::from_hours(1);
const FORWARDED: &str = "x-forwarded-for";

/// A state whose limiter refills so slowly that no test sees a refill.
async fn limited(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
    per_client: u32,
    global: u32,
) -> (AppState, PgPool) {
    let pool = app_login_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let identity =
        identity::Identity::new(db.clone(), "app.rampsmith.test", ORIGIN, "Rampsmith").unwrap();
    let state = AppState::new(db)
        .with_identity(identity)
        .with_start_limits(StartLimits {
            per_client: Rate {
                burst: per_client,
                every: HOUR,
            },
            global: Rate {
                burst: global,
                every: HOUR,
            },
            max_clients: 100,
        });
    (state, pool)
}

struct Answer {
    status: StatusCode,
    content_type: String,
    retry_after: Option<String>,
    body: Value,
}

async fn post_from(state: &AppState, path: &str, forwarded: Option<&str>, body: Body) -> Answer {
    let mut request = Request::post(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(value) = forwarded {
        request = request.header(FORWARDED, value);
    }
    let response = api::app(state.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let text = |name: header::HeaderName| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
    };
    let status = response.status();
    let content_type = text(header::CONTENT_TYPE).unwrap_or_default();
    let retry_after = text(header::RETRY_AFTER);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Answer {
        status,
        content_type,
        retry_after,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

async fn sign_in_start(state: &AppState, forwarded: Option<&str>) -> Answer {
    post_from(state, "/v1/auth/sign-in/start", forwarded, Body::empty()).await
}

async fn register_start(state: &AppState, forwarded: Option<&str>, email: &str) -> Answer {
    let body = json!({"email": email, "display_name": "Ada"}).to_string();
    post_from(
        state,
        "/v1/auth/register/start",
        forwarded,
        Body::from(body),
    )
    .await
}

async fn ceremonies(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from webauthn_ceremonies")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_client_over_its_limit_gets_429_with_retry_after_and_stores_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (state, pool) = limited(opts, conn, 2, 1000).await;
    for _ in 0..2 {
        assert_eq!(
            sign_in_start(&state, Some("203.0.113.7")).await.status,
            StatusCode::OK
        );
    }
    let refused = sign_in_start(&state, Some("203.0.113.7")).await;
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.content_type, "application/problem+json");
    assert_eq!(refused.body["code"], "rate_limited");
    assert_eq!(refused.body["status"], 429);
    let wait: u64 = refused.retry_after.as_deref().unwrap().parse().unwrap();
    assert!((1..=3600).contains(&wait), "{wait}");
    assert_eq!(
        ceremonies(&pool).await,
        2,
        "the refused request stored nothing"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn registration_and_sign_in_start_share_one_budget(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (state, _) = limited(opts, conn, 2, 1000).await;
    let client = Some("203.0.113.7");
    assert_eq!(sign_in_start(&state, client).await.status, StatusCode::OK);
    assert_eq!(
        register_start(&state, client, "ada@example.com")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        register_start(&state, client, "bob@example.com")
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        sign_in_start(&state, client).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn only_the_last_forwarded_entry_names_the_client(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (state, _) = limited(opts, conn, 1, 1000).await;
    assert_eq!(
        sign_in_start(&state, Some("203.0.113.7")).await.status,
        StatusCode::OK
    );
    // Inventing earlier entries does not buy a fresh budget: the web server's entry is last.
    for spoofed in ["1.2.3.4, 203.0.113.7", "5.6.7.8,9.9.9.9,203.0.113.7"] {
        assert_eq!(
            sign_in_start(&state, Some(spoofed)).await.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{spoofed}"
        );
    }
    // A different client is unaffected.
    assert_eq!(
        sign_in_start(&state, Some("1.2.3.4, 203.0.113.8"))
            .await
            .status,
        StatusCode::OK
    );
    // Two addresses in one IPv6 /64 are one client.
    assert_eq!(
        sign_in_start(&state, Some("2001:db8:1:2::1")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        sign_in_start(&state, Some("2001:db8:1:2:ffff::9"))
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_global_limit_holds_across_clients_and_for_requests_without_an_address(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (state, pool) = limited(opts, conn, 10, 3).await;
    for forwarded in [Some("203.0.113.1"), Some("203.0.113.2"), None] {
        assert_eq!(
            sign_in_start(&state, forwarded).await.status,
            StatusCode::OK
        );
    }
    for forwarded in [Some("203.0.113.3"), None, Some("garbage")] {
        let refused = sign_in_start(&state, forwarded).await;
        assert_eq!(
            refused.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{forwarded:?}"
        );
        assert_eq!(refused.body["code"], "rate_limited");
        assert!(refused.retry_after.is_some());
    }
    assert_eq!(ceremonies(&pool).await, 3);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_limited_request_is_refused_before_its_body_is_read(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (state, _) = limited(opts, conn, 1, 1000).await;
    let client = Some("203.0.113.7");
    assert_eq!(sign_in_start(&state, client).await.status, StatusCode::OK);
    let refused = post_from(
        &state,
        "/v1/auth/register/start",
        client,
        Body::from("{not json"),
    )
    .await;
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_limits_cover_only_the_start_endpoints(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (state, _) = limited(opts, conn, 1, 1).await;
    let client = Some("203.0.113.7");
    assert_eq!(sign_in_start(&state, client).await.status, StatusCode::OK);
    assert_eq!(
        sign_in_start(&state, client).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Verification and session calls answer as they always did.
    let finish = post_from(
        &state,
        "/v1/auth/sign-in/finish",
        client,
        Body::from(json!({"ceremony_id": uuid::Uuid::nil(), "credential": {}}).to_string()),
    )
    .await;
    assert_eq!(finish.status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&state, Method::GET, "/v1/auth/session", None, Some("nope")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
