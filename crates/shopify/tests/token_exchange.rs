//! Token exchange and refresh against a mock of Shopify's token endpoint (ADR-022).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::time::Duration;

use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use shopify::{ShopDomain, TokenClient, TokenEndpoint, TokenError};
use wiremock::matchers::{header, method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const CLIENT_SECRET: &str = "shpss_client_secret_value";

/// Matches a form body containing exactly these fields.
struct Form(Vec<(&'static str, &'static str)>);

impl Match for Form {
    fn matches(&self, request: &Request) -> bool {
        let got: HashMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        got.len() == self.0.len()
            && self
                .0
                .iter()
                .all(|(k, v)| got.get(*k).map(String::as_str) == Some(*v))
    }
}

fn shop() -> ShopDomain {
    ShopDomain::parse("demo-store.myshopify.com").unwrap()
}

fn client(server: &MockServer) -> TokenClient {
    TokenClient::new(
        CLIENT_ID,
        SecretString::from(CLIENT_SECRET),
        TokenEndpoint::Base(server.uri()),
        Duration::from_secs(2),
    )
    .unwrap()
}

fn token_body() -> serde_json::Value {
    json!({
        "access_token": "shpat_new_access",
        "scope": "read_products,write_products,read_themes",
        "expires_in": 3600,
        "refresh_token": "shprt_new_refresh",
        "refresh_token_expires_in": 7_776_000
    })
}

const TOKEN_PATH: &str = "/demo-store.myshopify.com/admin/oauth/access_token";

#[tokio::test]
async fn exchange_posts_the_documented_form_and_reads_an_expiring_offline_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .and(header("accept", "application/json"))
        .and(Form(vec![
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", "id.token.value"),
            (
                "subject_token_type",
                "urn:ietf:params:oauth:token-type:id_token",
            ),
            (
                "requested_token_type",
                "urn:shopify:params:oauth:token-type:offline-access-token",
            ),
            ("expiring", "1"),
        ]))
        .respond_with(ResponseTemplate::new(200).set_body_json(token_body()))
        .expect(1)
        .mount(&server)
        .await;

    let token = client(&server)
        .exchange(&shop(), "id.token.value")
        .await
        .unwrap();
    assert_eq!(token.access_token.expose_secret(), "shpat_new_access");
    assert_eq!(token.refresh_token.expose_secret(), "shprt_new_refresh");
    assert_eq!(
        token.scopes,
        ["read_products", "write_products", "read_themes"]
    );
    assert_eq!(token.expires_in, Duration::from_hours(1));
    assert_eq!(
        token.refresh_token_expires_in,
        Duration::from_hours(90 * 24)
    );
}

#[tokio::test]
async fn refresh_posts_the_documented_form() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .and(Form(vec![
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("grant_type", "refresh_token"),
            ("refresh_token", "shprt_old"),
        ]))
        .respond_with(ResponseTemplate::new(200).set_body_json(token_body()))
        .expect(1)
        .mount(&server)
        .await;

    let token = client(&server)
        .refresh(&shop(), &SecretString::from("shprt_old"))
        .await
        .unwrap();
    assert_eq!(token.refresh_token.expose_secret(), "shprt_new_refresh");
}

async fn exchange_status(status: u16) -> TokenError {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(status)
                .set_body_json(json!({"error": "some_error", "error_description": "shpat_leak"})),
        )
        .mount(&server)
        .await;
    client(&server)
        .exchange(&shop(), "id.token")
        .await
        .unwrap_err()
}

async fn refresh_status(status: u16) -> TokenError {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(status).set_body_string("shprt_leak"))
        .mount(&server)
        .await;
    client(&server)
        .refresh(&shop(), &SecretString::from("shprt_old"))
        .await
        .unwrap_err()
}

#[tokio::test]
async fn a_400_on_exchange_means_the_id_token_is_stale() {
    let error = exchange_status(400).await;
    assert_eq!(error, TokenError::InvalidSubjectToken);
    assert!(!error.is_retryable());
}

#[tokio::test]
async fn a_401_on_refresh_means_the_grant_was_revoked() {
    let error = refresh_status(401).await;
    assert_eq!(error, TokenError::Revoked);
    assert!(!error.is_retryable());
}

#[tokio::test]
async fn throttling_and_server_errors_are_retryable() {
    for status in [429, 500, 502, 503] {
        let error = refresh_status(status).await;
        assert!(error.is_retryable(), "{status}: {error:?}");
        let error = exchange_status(status).await;
        assert!(error.is_retryable(), "{status}: {error:?}");
    }
}

#[tokio::test]
async fn other_client_errors_are_rejections_that_do_not_retry() {
    for status in [400, 403, 404] {
        let error = refresh_status(status).await;
        assert_eq!(error, TokenError::Rejected { status }, "{status}");
        assert!(!error.is_retryable());
    }
    for status in [401, 403] {
        let error = exchange_status(status).await;
        assert_eq!(error, TokenError::Rejected { status }, "{status}");
    }
}

#[tokio::test]
async fn errors_never_carry_response_bodies() {
    for error in [
        exchange_status(400).await,
        exchange_status(500).await,
        refresh_status(401).await,
    ] {
        let text = format!("{error} {error:?}");
        assert!(!text.contains("leak"), "{text}");
    }
}

#[tokio::test]
async fn a_response_without_a_refresh_token_is_rejected() {
    // expiring=1 was asked for; a non-expiring token would silently break rotation.
    let server = MockServer::start().await;
    let mut body = token_body();
    body.as_object_mut().unwrap().remove("refresh_token");
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    let error = client(&server)
        .exchange(&shop(), "id.token")
        .await
        .unwrap_err();
    assert_eq!(error, TokenError::Decode);
}

#[tokio::test]
async fn a_slow_endpoint_times_out_as_a_retryable_transport_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(token_body())
                .set_delay(Duration::from_secs(5)),
        )
        .mount(&server)
        .await;
    let error = client(&server)
        .exchange(&shop(), "id.token")
        .await
        .unwrap_err();
    assert_eq!(error, TokenError::Transport);
    assert!(error.is_retryable());
}

#[test]
fn the_production_endpoint_is_the_shops_admin() {
    assert_eq!(
        TokenEndpoint::Shopify.url(&shop()),
        "https://demo-store.myshopify.com/admin/oauth/access_token"
    );
}

#[test]
fn the_offline_token_debug_output_hides_secrets() {
    let token = shopify::OfflineToken {
        access_token: SecretString::from("shpat_secret"),
        scopes: vec![],
        expires_in: Duration::from_secs(1),
        refresh_token: SecretString::from("shprt_secret"),
        refresh_token_expires_in: Duration::from_secs(1),
    };
    let debug = format!("{token:?}");
    assert!(!debug.contains("shpat_secret") && !debug.contains("shprt_secret"));
}
