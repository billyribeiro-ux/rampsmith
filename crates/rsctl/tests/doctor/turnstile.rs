//! C row 6, Turnstile: the secret key verifies tokens.

use rsctl::report::Target;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, json, pass, skip_missing};

const SECRET: &str = "0x4SECRETsecretSECRETsecret_test";
const SITE: &str = "0x4AAAAAAAsitekey";

async fn rig() -> Rig {
    Rig::new(&[
        ("TURNSTILE_SITE_KEY", SITE),
        ("TURNSTILE_SECRET_KEY", SECRET),
    ])
    .await
}

pub fn vars() -> Vec<(&'static str, &'static str)> {
    vec![
        ("TURNSTILE_SITE_KEY", SITE),
        ("TURNSTILE_SECRET_KEY", SECRET),
    ]
}

pub async fn healthy(server: &wiremock::MockServer) {
    siteverify()
        .respond_with(json(200, "turnstile/invalid-input-response.json"))
        .mount(server)
        .await;
}

fn siteverify() -> wiremock::MockBuilder {
    Mock::given(method("POST")).and(path("/turnstile/v0/siteverify"))
}

#[tokio::test]
async fn a_real_secret_answers_invalid_input_response_to_a_made_up_token() {
    let rig = rig().await;
    siteverify()
        .and(body_string_contains(format!("secret={SECRET}")))
        .and(body_string_contains("response="))
        .respond_with(json(200, "turnstile/invalid-input-response.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("turnstile.siteverify").await;
    let detail = pass(&outcome);
    assert!(detail.contains("invalid-input-response"), "{detail}");
    assert!(!detail.contains(SECRET));
}

#[tokio::test]
async fn a_wrong_secret_fails() {
    let rig = rig().await;
    siteverify()
        .respond_with(json(200, "turnstile/invalid-input-secret.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("turnstile.siteverify").await;
    assert!(fail(&outcome).contains("invalid-input-secret"));
}

#[tokio::test]
async fn a_secret_that_accepts_a_made_up_token_is_a_testing_secret_and_fails() {
    let rig = rig().await;
    siteverify()
        .respond_with(json(200, "turnstile/accepted.json"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("turnstile.siteverify").await).contains("testing secret"));
}

#[tokio::test]
async fn cloudflares_dummy_secrets_fail_in_production_without_a_request() {
    let rig = Rig::new(&[
        ("TURNSTILE_SITE_KEY", "1x00000000000000000000AA"),
        (
            "TURNSTILE_SECRET_KEY",
            "2x0000000000000000000000000000000AA",
        ),
    ])
    .await;
    let outcome = rig.run("turnstile.siteverify").await;
    assert!(fail(&outcome).contains("testing secrets"), "{outcome:?}");
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn cloudflares_dummy_secrets_are_probed_in_staging() {
    let mut rig = Rig::new(&[
        ("TURNSTILE_SITE_KEY", "1x00000000000000000000AA"),
        (
            "TURNSTILE_SECRET_KEY",
            "2x0000000000000000000000000000000AA",
        ),
    ])
    .await;
    rig.options.target = Target::Staging;
    siteverify()
        .respond_with(json(200, "turnstile/invalid-input-response.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    pass(&rig.run("turnstile.siteverify").await);
}

#[tokio::test]
async fn other_codes_give_no_verdict_and_are_printed_as_codes_only() {
    let rig = rig().await;
    siteverify()
        .respond_with(json(200, "turnstile/internal-error.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("turnstile.siteverify").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("internal-error") && detail.contains("no verdict"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_non_json_answer_fails() {
    let rig = rig().await;
    siteverify()
        .respond_with(ResponseTemplate::new(502).set_body_string("<html>bad gateway</html>"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("turnstile.siteverify").await).contains("502"));
}

#[tokio::test]
async fn only_the_secret_set_is_a_partial_input() {
    let rig = Rig::new(&[("TURNSTILE_SECRET_KEY", SECRET)]).await;
    let outcome = rig.run("turnstile.siteverify").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete")
            && detail.contains("TURNSTILE_SITE_KEY")
            && detail.contains("C row 6"),
        "{detail}"
    );
}

#[tokio::test]
async fn nothing_set_skips_naming_row_6() {
    let rig = Rig::new(&[]).await;
    let outcome = rig.run("turnstile.siteverify").await;
    assert!(skip_missing(&outcome).contains("C row 6"));
}
