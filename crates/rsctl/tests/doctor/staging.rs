//! C row 15: staging has its own copies of the Shopify app and the GitHub App.

use rsctl::report::Target;

use crate::support::{Rig, fail, pass, skip_missing};

async fn rig(shopify: &str, github: &str) -> Rig {
    let mut rig = Rig::new(&[("SHOPIFY_API_KEY", shopify), ("GITHUB_APP_ID", github)]).await;
    rig.options.target = Target::Staging;
    rig.options.production_shopify_api_key = Some("prod-client-id".to_owned());
    rig.options.production_github_app_id = Some("111".to_owned());
    rig
}

#[tokio::test]
async fn separate_apps_pass_without_any_request() {
    let rig = rig("staging-client-id", "222").await;
    let outcome = rig.run("staging.separate-apps").await;
    assert!(
        pass(&outcome).contains("its own Shopify app and its own GitHub App"),
        "{outcome:?}"
    );
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn sharing_either_app_with_production_fails_and_says_which() {
    let outcome = rig("prod-client-id", "222")
        .await
        .run("staging.separate-apps")
        .await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("Shopify app") && !detail.contains("GitHub App"),
        "{detail}"
    );

    let outcome = rig("staging-client-id", "111")
        .await
        .run("staging.separate-apps")
        .await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("GitHub App") && !detail.contains("Shopify app"),
        "{detail}"
    );

    let outcome = rig("prod-client-id", "111")
        .await
        .run("staging.separate-apps")
        .await;
    assert!(fail(&outcome).contains("Shopify app (SHOPIFY_API_KEY) and the GitHub App"));
}

#[tokio::test]
async fn without_the_production_identifiers_there_is_nothing_to_compare() {
    let mut rig = rig("staging-client-id", "222").await;
    rig.options.production_github_app_id = None;
    let outcome = rig.run("staging.separate-apps").await;
    let detail = skip_missing(&outcome);
    assert!(
        detail.contains("C row 15") && detail.contains("--production-shopify-api-key"),
        "{detail}"
    );
}

#[tokio::test]
async fn missing_staging_identifiers_skip_naming_row_15() {
    let mut rig = Rig::new(&[("SHOPIFY_API_KEY", "staging-client-id")]).await;
    rig.options.target = Target::Staging;
    let outcome = rig.run("staging.separate-apps").await;
    let detail = skip_missing(&outcome);
    assert!(
        detail.contains("C row 15") && detail.contains("GITHUB_APP_ID"),
        "{detail}"
    );
    assert!(!detail.contains("SHOPIFY_API_KEY"), "{detail}");
}
