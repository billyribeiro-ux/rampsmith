//! C row 5: the Anthropic API key lists models.

use wiremock::matchers::{header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, fixture, json, pass, skip_missing};

const KEY: &str = "test-anthropic-key-SECRET-1";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    vec![("ANTHROPIC_API_KEY", KEY)]
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(json(200, "anthropic/models.json"))
        .mount(server)
        .await;
}

async fn rig() -> Rig {
    Rig::new(&[("ANTHROPIC_API_KEY", KEY)]).await
}

#[tokio::test]
async fn lists_models_with_the_documented_headers_and_names_the_plan_models() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(query_param("limit", "1000"))
        .and(header("x-api-key", KEY))
        .and(header("anthropic-version", "2023-06-01"))
        .respond_with(json(200, "anthropic/models.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("anthropic.models").await;
    let detail = pass(&outcome);
    assert!(detail.contains("3 models"), "{detail}");
    assert!(detail.contains("claude-haiku-5-5"), "{detail}");
    assert!(!detail.contains(KEY));
}

#[tokio::test]
async fn follows_pagination_and_accepts_dated_model_ids() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(query_param_is_missing("after_id"))
        .respond_with(json(200, "anthropic/models-page-1.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(query_param("after_id", "claude-opus-5-5"))
        .respond_with(json(200, "anthropic/models-page-2.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("anthropic.models").await;
    assert!(pass(&outcome).contains("3 models"));
}

#[tokio::test]
async fn a_rejected_key_fails_with_the_vendor_code_and_not_its_text() {
    // The body is a real response recorded from api.anthropic.com on 2026-10-19.
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(json(401, "anthropic/models-401-bad-key.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("anthropic.models").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("401") && detail.contains("authentication_error"),
        "{detail}"
    );
    assert!(detail.contains("rejected"), "{detail}");
    assert!(
        !detail.contains("invalid x-api-key"),
        "vendor text must not be printed: {detail}"
    );
    assert!(
        !detail.contains("req_011"),
        "request ids are not printed: {detail}"
    );
}

#[tokio::test]
async fn a_key_without_the_plan_models_fails_naming_them() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(json(200, "anthropic/models-haiku-only.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("anthropic.models").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("claude-sonnet-5-5") && detail.contains("claude-opus-5-5"),
        "{detail}"
    );
    assert!(!detail.contains("claude-haiku-5-5"), "{detail}");
}

#[tokio::test]
async fn a_200_without_the_list_shape_fails() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>captive portal</html>"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("anthropic.models").await).contains("documented list shape"));
}

#[tokio::test]
async fn a_key_that_cannot_be_a_header_is_refused_without_being_echoed() {
    let rig = Rig::new(&[("ANTHROPIC_API_KEY", "two words\nSECRETMARK")]).await;
    let outcome = rig.run("anthropic.models").await;
    let detail = fail(&outcome);
    assert!(detail.contains("ANTHROPIC_API_KEY"), "{detail}");
    assert!(!detail.contains("SECRETMARK"), "{detail}");
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn an_unset_key_skips_naming_row_5() {
    let rig = Rig::new(&[]).await;
    let outcome = rig.run("anthropic.models").await;
    let detail = skip_missing(&outcome);
    assert!(
        detail.contains("ANTHROPIC_API_KEY") && detail.contains("C row 5"),
        "{detail}"
    );
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[test]
fn the_fixtures_are_the_documented_shapes() {
    let list: serde_json::Value = serde_json::from_str(&fixture("anthropic/models.json")).unwrap();
    assert!(list["data"][0]["id"].is_string() && list["has_more"].is_boolean());
    let error: serde_json::Value =
        serde_json::from_str(&fixture("anthropic/models-401-bad-key.json")).unwrap();
    assert_eq!(error["error"]["type"], "authentication_error");
}
