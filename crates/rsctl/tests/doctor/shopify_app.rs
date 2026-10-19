//! C row 1: the Shopify app's client id and secret, through the client credentials grant.

use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, fixture, json, pass, skip_missing};

const KEY: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "test-shopify-client-secret-SECRET-1";
const STORE: &str = "rampsmith-dev-a.myshopify.com";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    all()
}

pub async fn healthy(server: &wiremock::MockServer) {
    token_request()
        .respond_with(json(200, "shopify/token.json"))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/api/2026-10/graphql.json"))
        .respond_with(json(200, "shopify/current-app-installation.json"))
        .mount(server)
        .await;
}

fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SHOPIFY_API_KEY", KEY),
        ("SHOPIFY_API_SECRET", SECRET),
        ("SHOPIFY_DEV_STORE_DOMAIN", STORE),
    ]
}

fn token_request() -> wiremock::MockBuilder {
    Mock::given(method("POST"))
        .and(path("/admin/oauth/access_token"))
        .and(body_string_contains("grant_type=client_credentials"))
        .and(body_string_contains(format!("client_id={KEY}")))
        .and(body_string_contains(format!("client_secret={SECRET}")))
}

#[tokio::test]
async fn the_credentials_are_exchanged_and_the_minted_token_reads_the_installation() {
    let rig = Rig::new(&all()).await;
    token_request()
        .respond_with(json(200, "shopify/token.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/api/2026-10/graphql.json"))
        .and(header(
            "x-shopify-access-token",
            "fixture-minted-access-token-0123456789",
        ))
        .and(body_string_contains("currentAppInstallation"))
        .and(body_string_contains("accessScopes"))
        .respond_with(json(200, "shopify/current-app-installation.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.app").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("2 access scope(s)") && detail.contains("2026-10"),
        "{detail}"
    );
    assert!(!detail.contains(SECRET) && !detail.contains("fixture-minted-access-token"));
}

#[tokio::test]
async fn the_minted_token_is_registered_for_redaction() {
    let rig = Rig::new(&all()).await;
    token_request()
        .respond_with(json(200, "shopify/token.json"))
        .mount(&rig.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/api/2026-10/graphql.json"))
        .respond_with(json(200, "shopify/current-app-installation.json"))
        .mount(&rig.server)
        .await;
    let ctx = rig.ctx();
    rig.run_with("shopify.app", &ctx).await;
    assert_eq!(
        ctx.redactor
            .scrub("x fixture-minted-access-token-0123456789 y"),
        "x [REDACTED] y"
    );
}

#[tokio::test]
async fn rejected_credentials_fail_with_the_oauth_code() {
    let rig = Rig::new(&all()).await;
    Mock::given(method("POST"))
        .and(path("/admin/oauth/access_token"))
        .respond_with(json(400, "shopify/token-invalid-client.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.app").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("400") && detail.contains("invalid_client"),
        "{detail}"
    );
    assert!(!detail.contains("Client authentication failed"), "{detail}");
}

#[tokio::test]
async fn an_app_that_is_not_installed_is_explained() {
    let rig = Rig::new(&all()).await;
    Mock::given(method("POST"))
        .and(path("/admin/oauth/access_token"))
        .respond_with(json(400, "shopify/token-app-not-installed.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.app").await;
    assert!(fail(&outcome).contains("install the app on the store first"));
}

#[tokio::test]
async fn a_graphql_access_error_fails_with_its_code() {
    let rig = Rig::new(&all()).await;
    token_request()
        .respond_with(json(200, "shopify/token.json"))
        .mount(&rig.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/api/2026-10/graphql.json"))
        .respond_with(json(200, "shopify/graphql-access-denied.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.app").await;
    let detail = fail(&outcome);
    assert!(detail.contains("ACCESS_DENIED"), "{detail}");
    assert!(
        !detail.contains("Access denied for currentAppInstallation"),
        "{detail}"
    );
}

#[tokio::test]
async fn an_admin_api_401_fails() {
    let rig = Rig::new(&all()).await;
    token_request()
        .respond_with(json(200, "shopify/token.json"))
        .mount(&rig.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/api/2026-10/graphql.json"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.app").await).contains("rejected the minted token"));
}

#[tokio::test]
async fn the_credentials_without_a_store_skip_naming_row_3() {
    let rig = Rig::new(&[("SHOPIFY_API_KEY", KEY), ("SHOPIFY_API_SECRET", SECRET)]).await;
    let outcome = rig.run("shopify.app").await;
    let detail = skip_missing(&outcome);
    assert!(
        detail.contains("C row 3") && detail.contains("SHOPIFY_DEV_STORE_DOMAIN"),
        "{detail}"
    );
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_key_without_its_secret_is_a_partial_input() {
    let rig = Rig::new(&[
        ("SHOPIFY_API_KEY", KEY),
        ("SHOPIFY_DEV_STORE_DOMAIN", STORE),
    ])
    .await;
    let outcome = rig.run("shopify.app").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("SHOPIFY_API_SECRET"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_domain_that_is_not_a_myshopify_domain_is_refused_before_any_request() {
    let rig = Rig::new(&[
        ("SHOPIFY_API_KEY", KEY),
        ("SHOPIFY_API_SECRET", SECRET),
        ("SHOPIFY_DEV_STORE_DOMAIN", "attacker.example.com"),
    ])
    .await;
    let outcome = rig.run("shopify.app").await;
    assert!(fail(&outcome).contains("*.myshopify.com"));
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn nothing_set_skips_naming_row_1() {
    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("shopify.app").await).contains("C row 1"));
}

#[test]
fn the_token_fixture_is_the_documented_response_shape() {
    let token: serde_json::Value = serde_json::from_str(&fixture("shopify/token.json")).unwrap();
    assert!(token["access_token"].is_string() && token["scope"].is_string());
    assert_eq!(token["expires_in"], 86399);
}
