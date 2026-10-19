//! C row 11: the Stripe secret key retrieves the account.

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, json, pass, skip_missing};

const SECRET: &str = "sk_test_not_a_real_key_marker";
const PUBLISHABLE: &str = "pk_test_not_a_real_key_marker";
const WEBHOOK: &str = "whsec_not_a_real_secret_marker";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    all()
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("GET"))
        .and(path("/v1/account"))
        .respond_with(json(200, "stripe/account.json"))
        .mount(server)
        .await;
}

fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("STRIPE_SECRET_KEY", SECRET),
        ("STRIPE_PUBLISHABLE_KEY", PUBLISHABLE),
        ("STRIPE_WEBHOOK_SECRET", WEBHOOK),
    ]
}

#[tokio::test]
async fn the_secret_key_retrieves_the_account() {
    let rig = Rig::new(&all()).await;
    Mock::given(method("GET"))
        .and(path("/v1/account"))
        .and(header("authorization", format!("Bearer {SECRET}").as_str()))
        .respond_with(json(200, "stripe/account.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("stripe.account").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("acct_1032D82eZvKYlo2C") && detail.contains("test mode"),
        "{detail}"
    );
    assert!(!detail.contains(SECRET) && !detail.contains(WEBHOOK));
}

#[tokio::test]
async fn a_rejected_key_fails_with_the_code_only() {
    let rig = Rig::new(&all()).await;
    Mock::given(method("GET"))
        .and(path("/v1/account"))
        .respond_with(json(401, "stripe/error-401.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("stripe.account").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("401") && detail.contains("api_key_invalid") && detail.contains("rejected"),
        "{detail}"
    );
    assert!(!detail.contains("Invalid API Key provided"), "{detail}");
}

#[tokio::test]
async fn mismatched_modes_and_shapes_fail_before_any_request() {
    let rig = Rig::new(&[
        ("STRIPE_SECRET_KEY", SECRET),
        ("STRIPE_PUBLISHABLE_KEY", "pk_live_not_a_real_key_marker"),
        ("STRIPE_WEBHOOK_SECRET", WEBHOOK),
    ])
    .await;
    let outcome = rig.run("stripe.account").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("test-mode") && detail.contains("live-mode"),
        "{detail}"
    );

    let rig = Rig::new(&[
        ("STRIPE_SECRET_KEY", "whsec_wrong_kind_of_key"),
        ("STRIPE_PUBLISHABLE_KEY", PUBLISHABLE),
        ("STRIPE_WEBHOOK_SECRET", WEBHOOK),
    ])
    .await;
    assert!(fail(&rig.run("stripe.account").await).contains("not a Stripe secret"));

    let rig = Rig::new(&[
        ("STRIPE_SECRET_KEY", SECRET),
        ("STRIPE_PUBLISHABLE_KEY", PUBLISHABLE),
        ("STRIPE_WEBHOOK_SECRET", "not-a-signing-secret"),
    ])
    .await;
    let outcome = rig.run("stripe.account").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("whsec_") && !detail.contains("not-a-signing-secret"),
        "{detail}"
    );
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_200_that_is_not_an_account_fails() {
    let rig = Rig::new(&all()).await;
    Mock::given(method("GET"))
        .and(path("/v1/account"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("stripe.account").await).contains("not with an account object"));
}

#[tokio::test]
async fn partial_and_unset_inputs() {
    let rig = Rig::new(&[("STRIPE_SECRET_KEY", SECRET)]).await;
    let outcome = rig.run("stripe.account").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("STRIPE_PUBLISHABLE_KEY"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    let outcome = rig.run("stripe.account").await;
    assert!(skip_missing(&outcome).contains("C row 11"));
}
