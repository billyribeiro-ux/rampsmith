//! C row 2: the Partner API client, and the App Automation Token that cannot be checked.

use serde_json::json;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, json, pass, skip_missing, skip_not_verifiable};

const TOKEN: &str = "test-partner-token-SECRET-1";
const KEY: &str = "0123456789abcdef0123456789abcdef";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    let mut all = all();
    all.push((
        "SHOPIFY_APP_AUTOMATION_TOKEN",
        "test-automation-token-SECRET-3",
    ));
    all
}

pub async fn healthy(server: &wiremock::MockServer) {
    endpoint()
        .respond_with(json(200, "partner/app.json"))
        .mount(server)
        .await;
}

fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SHOPIFY_PARTNER_API_TOKEN", TOKEN),
        ("SHOPIFY_PARTNER_ORG_ID", "4321"),
        ("SHOPIFY_APP_GID", "gid://shopify/App/1234"),
    ]
}

fn endpoint() -> wiremock::MockBuilder {
    Mock::given(method("POST"))
        .and(path("/4321/api/2026-10/graphql.json"))
        .and(header("x-shopify-access-token", TOKEN))
}

#[tokio::test]
async fn the_client_reads_the_app() {
    let rig = Rig::new(&all()).await;
    endpoint()
        .and(body_string_contains("gid://shopify/App/1234"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": {"app": {"id": "gid://shopify/App/1234", "name": "Rampsmith", "apiKey": KEY}}
        })))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.partner-api").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("`Rampsmith`") && detail.contains("organization 4321"),
        "{detail}"
    );
    assert!(!detail.contains("partners/App"), "{detail}");
    assert!(!detail.contains(TOKEN));
}

#[tokio::test]
async fn the_documented_gid_form_is_tried_when_the_configured_one_is_refused() {
    let rig = Rig::new(&all()).await;
    endpoint()
        .and(body_string_contains("gid://shopify/App/1234"))
        .respond_with(json(200, "partner/app-null.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    endpoint()
        .and(body_string_contains("gid://partners/App/1234"))
        .respond_with(json(200, "partner/app.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.partner-api").await;
    let detail = pass(&outcome);
    assert!(detail.contains("gid://partners/App form"), "{detail}");
}

#[tokio::test]
async fn neither_gid_form_fails() {
    let rig = Rig::new(&all()).await;
    endpoint()
        .respond_with(json(200, "partner/app-null.json"))
        .expect(2)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.partner-api").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("returned no app") && detail.contains("Manage apps"),
        "{detail}"
    );
    assert!(!detail.contains("App not found"), "{detail}");
}

#[tokio::test]
async fn an_app_with_another_api_key_fails() {
    let mut vars = all();
    vars.push(("SHOPIFY_API_KEY", "ffffffffffffffffffffffffffffffff"));
    let rig = Rig::new(&vars).await;
    endpoint()
        .respond_with(json(200, "partner/app.json"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.partner-api").await).contains("differs from SHOPIFY_API_KEY"));
}

#[tokio::test]
async fn a_matching_api_key_passes() {
    let mut vars = all();
    vars.push(("SHOPIFY_API_KEY", KEY));
    let rig = Rig::new(&vars).await;
    endpoint()
        .respond_with(json(200, "partner/app.json"))
        .mount(&rig.server)
        .await;
    pass(&rig.run("shopify.partner-api").await);
}

#[tokio::test]
async fn http_401_and_429_are_explained() {
    let rig = Rig::new(&all()).await;
    endpoint()
        .respond_with(ResponseTemplate::new(401))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.partner-api").await).contains("rejected the client"));

    let rig = Rig::new(&all()).await;
    endpoint()
        .respond_with(json(429, "partner/throttled.json"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.partner-api").await).contains("rate limit"));
}

#[tokio::test]
async fn malformed_ids_fail_before_any_request() {
    for (org, gid, needle) in [
        (
            "not-a-number",
            "gid://shopify/App/1234",
            "SHOPIFY_PARTNER_ORG_ID",
        ),
        ("4321", "gid://shopify/Shop/1234", "SHOPIFY_APP_GID"),
        ("4321", "1234", "SHOPIFY_APP_GID"),
    ] {
        let rig = Rig::new(&[
            ("SHOPIFY_PARTNER_API_TOKEN", TOKEN),
            ("SHOPIFY_PARTNER_ORG_ID", org),
            ("SHOPIFY_APP_GID", gid),
        ])
        .await;
        let outcome = rig.run("shopify.partner-api").await;
        assert!(fail(&outcome).contains(needle), "{outcome:?}");
        assert!(rig.server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_token_without_an_org_is_a_partial_input_and_nothing_set_skips() {
    let rig = Rig::new(&[("SHOPIFY_PARTNER_API_TOKEN", TOKEN)]).await;
    let outcome = rig.run("shopify.partner-api").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("SHOPIFY_PARTNER_ORG_ID"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("shopify.partner-api").await).contains("C row 2"));
}

#[tokio::test]
async fn the_app_automation_token_is_reported_as_not_verifiable_and_never_sent() {
    let rig = Rig::new(&[(
        "SHOPIFY_APP_AUTOMATION_TOKEN",
        "test-automation-token-SECRET-3",
    )])
    .await;
    let outcome = rig.run("shopify.automation-token").await;
    let detail = skip_not_verifiable(&outcome);
    assert!(detail.contains("shopify app deploy"), "{detail}");
    assert!(!detail.contains("SECRET-3"));
    assert!(rig.server.received_requests().await.unwrap().is_empty());

    let rig = Rig::new(&[]).await;
    let outcome = rig.run("shopify.automation-token").await;
    assert!(skip_missing(&outcome).contains("SHOPIFY_APP_AUTOMATION_TOKEN"));
}
