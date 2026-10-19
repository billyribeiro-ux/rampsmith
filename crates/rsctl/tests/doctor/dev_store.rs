//! C row 3: the two development stores.

use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, pass, skip_missing};

const A: &str = "rampsmith-dev-a.myshopify.com";
const B: &str = "rampsmith-dev-b.myshopify.com";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    both()
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("GET"))
        .and(path("/password"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string("<html>Enter store using password</html>"),
        )
        .mount(server)
        .await;
}

fn both() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SHOPIFY_DEV_STORE_DOMAIN", A),
        ("SHOPIFY_DEV_STORE_PASSWORD", "test-store-password-SECRET-1"),
        ("SHOPIFY_DEV_STORE_B_DOMAIN", B),
        (
            "SHOPIFY_DEV_STORE_B_PASSWORD",
            "test-store-password-SECRET-2",
        ),
    ]
}

#[tokio::test]
async fn a_store_that_shows_the_password_page_passes_and_the_password_is_not_checked_or_sent() {
    let rig = Rig::new(&both()).await;
    Mock::given(method("GET"))
        .and(path("/password"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string("<html>Enter store using password</html>"),
        )
        .expect(2)
        .mount(&rig.server)
        .await;
    let a = rig.run("shopify.dev-store-a").await;
    let b = rig.run("shopify.dev-store-b").await;
    assert!(
        pass(&a).contains("store A") && pass(&a).contains(A),
        "{a:?}"
    );
    assert!(
        pass(&b).contains("store B") && pass(&b).contains(B),
        "{b:?}"
    );
    assert!(pass(&a).contains("no way to check it"), "{a:?}");
    for request in rig.server.received_requests().await.unwrap() {
        assert_eq!(request.method.as_str(), "GET");
        assert!(request.body.is_empty());
        assert!(!request.url.as_str().contains("SECRET"));
    }
}

#[tokio::test]
async fn a_store_without_a_storefront_password_redirects_and_fails() {
    let rig = Rig::new(&both()).await;
    Mock::given(method("GET"))
        .and(path("/password"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://elsewhere.example/"),
        )
        .mount(&rig.server)
        .await;
    let outcome = rig.run("shopify.dev-store-a").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("302") && detail.contains("no storefront password"),
        "{detail}"
    );
    assert!(
        !detail.contains("elsewhere.example"),
        "the redirect target is not followed or printed: {detail}"
    );
}

#[tokio::test]
async fn bot_checks_are_reported_not_solved() {
    let rig = Rig::new(&both()).await;
    Mock::given(method("GET"))
        .and(path("/password"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.dev-store-b").await).contains("never tries to pass"));
}

#[tokio::test]
async fn other_statuses_and_bad_domains_fail() {
    let rig = Rig::new(&both()).await;
    Mock::given(method("GET"))
        .and(path("/password"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("shopify.dev-store-a").await).contains("404"));

    let rig = Rig::new(&[
        ("SHOPIFY_DEV_STORE_DOMAIN", "https://store.myshopify.com/"),
        ("SHOPIFY_DEV_STORE_PASSWORD", "x-SECRET"),
    ])
    .await;
    let outcome = rig.run("shopify.dev-store-a").await;
    assert!(fail(&outcome).contains("*.myshopify.com"));
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_domain_without_its_password_is_partial_and_unset_skips() {
    let rig = Rig::new(&[("SHOPIFY_DEV_STORE_B_DOMAIN", B)]).await;
    let outcome = rig.run("shopify.dev-store-b").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("SHOPIFY_DEV_STORE_B_PASSWORD"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("shopify.dev-store-a").await).contains("C row 3"));
    assert!(skip_missing(&rig.run("shopify.dev-store-b").await).contains("C row 3"));
}
