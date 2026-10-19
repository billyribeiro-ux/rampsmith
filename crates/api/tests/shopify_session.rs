//! `POST /v1/shopify/session` and the session extractor (ADR-022).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use crypto::KeyRing;
use db::Db;
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use secrecy::SecretString;
use serde_json::{Value, json};
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::ShopifyAuth;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

mod support;

use support::app_login_pool;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_api_test";
const RETRY: &str = "x-shopify-retry-invalid-session-request";

async fn state(opts: PgPoolOptions, conn: PgConnectOptions, shopify: &MockServer) -> AppState {
    let pool = app_login_pool(opts, conn).await;
    let db = Db::from_pool(pool);
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse("k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            Duration::from_secs(2),
        )
        .unwrap(),
    );
    AppState::new(db).with_shopify(auth)
}

fn id_token(secret: &str) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    encode(
        &Header::new(Algorithm::HS256),
        &json!({
            "iss": "https://demo-store.myshopify.com/admin",
            "dest": "https://demo-store.myshopify.com",
            "aud": CLIENT_ID,
            "sub": "42",
            "exp": now + 60,
            "nbf": now - 1,
            "iat": now - 1,
            "jti": "j",
            "sid": "s"
        }),
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

struct Answer {
    status: StatusCode,
    content_type: String,
    retry: Option<String>,
    body: Value,
}

async fn post_session(state: AppState, authorization: Option<&str>) -> Answer {
    let mut request = Request::post("/v1/shopify/session");
    if let Some(value) = authorization {
        request = request.header(header::AUTHORIZATION, value);
    }
    let res = api::app(state)
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let header_text = |name: &str| {
        res.headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
    };
    let status = res.status();
    let content_type = header_text(header::CONTENT_TYPE.as_str()).unwrap_or_default();
    let retry = header_text(RETRY);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    Answer {
        status,
        content_type,
        retry,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

async fn exchange_answers(server: &MockServer, status: u16) {
    let body = json!({
        "access_token": "shpat_a",
        "scope": "read_products",
        "expires_in": 3600,
        "refresh_token": "shprt_r",
        "refresh_token_expires_in": 7_776_000
    });
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(server)
        .await;
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_first_session_installs_and_later_ones_do_not(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let shopify = MockServer::start().await;
    exchange_answers(&shopify, 200).await;
    let state = state(opts, conn, &shopify).await;
    let bearer = format!("Bearer {}", id_token(SECRET));

    let first = post_session(state.clone(), Some(&bearer)).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(
        first.body,
        json!({"shop": "demo-store.myshopify.com", "installed": true})
    );
    let second = post_session(state, Some(&bearer)).await;
    assert_eq!(second.body["installed"], false);
    assert_eq!(shopify.received_requests().await.unwrap().len(), 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn missing_or_invalid_tokens_answer_401_with_the_retry_header(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let shopify = MockServer::start().await;
    let state = state(opts, conn, &shopify).await;
    let forged = format!("Bearer {}", id_token("not-the-secret"));
    for authorization in [
        None,
        Some(""),
        Some("Basic dXNlcjpwYXNz"),
        Some("Bearer "),
        Some("Bearer not.a.jwt"),
        Some(forged.as_str()),
    ] {
        let answer = post_session(state.clone(), authorization).await;
        assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{authorization:?}");
        assert_eq!(answer.content_type, "application/problem+json");
        assert_eq!(answer.retry.as_deref(), Some("1"), "{authorization:?}");
        assert_eq!(answer.body["code"], "unauthenticated");
    }
    assert!(shopify.received_requests().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_token_shopify_calls_stale_answers_401_with_the_retry_header(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let shopify = MockServer::start().await;
    exchange_answers(&shopify, 400).await;
    let state = state(opts, conn, &shopify).await;
    let answer = post_session(state, Some(&format!("Bearer {}", id_token(SECRET)))).await;
    assert_eq!(answer.status, StatusCode::UNAUTHORIZED);
    assert_eq!(answer.retry.as_deref(), Some("1"));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_shopify_outage_answers_502_without_the_retry_header(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let shopify = MockServer::start().await;
    exchange_answers(&shopify, 503).await;
    let state = state(opts, conn, &shopify).await;
    let answer = post_session(state, Some(&format!("Bearer {}", id_token(SECRET)))).await;
    assert_eq!(answer.status, StatusCode::BAD_GATEWAY);
    assert_eq!(answer.body["code"], "upstream_failed");
    assert!(answer.retry.is_none());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn bad_client_credentials_are_a_server_error_that_leaks_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let shopify = MockServer::start().await;
    exchange_answers(&shopify, 401).await;
    let state = state(opts, conn, &shopify).await;
    let answer = post_session(state, Some(&format!("Bearer {}", id_token(SECRET)))).await;
    assert_eq!(answer.status, StatusCode::INTERNAL_SERVER_ERROR);
    let text = answer.body.to_string();
    assert!(
        !text.contains("client") && !text.contains("secret"),
        "{text}"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_shopify_configured_the_route_is_unavailable(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_login_pool(opts, conn).await;
    let state = AppState::new(Db::from_pool(pool));
    let answer = post_session(state, Some("Bearer x")).await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn the_openapi_document_declares_the_session_route_and_its_bearer_scheme() {
    let doc = serde_json::to_value(api::openapi()).unwrap();
    let op = &doc["paths"]["/v1/shopify/session"]["post"];
    assert_eq!(op["operationId"], "createShopifySession");
    assert_eq!(op["security"][0]["shopify_session"], json!([]));
    assert!(op["responses"]["401"].is_object());
    assert_eq!(
        doc["components"]["securitySchemes"]["shopify_session"]["scheme"],
        "bearer"
    );
}
