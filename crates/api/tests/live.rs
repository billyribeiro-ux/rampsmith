//! The Partner API against the real service (LAUNCH.md section E, row 4).
//!
//! Skips, naming what it needs, until the founder's Partner organization exists: set
//! `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_APP_GID` and
//! `RAMPSMITH_LIVE_SHOP_GID` (`gid://shopify/Shop/<n>` of a development store that has the app
//! installed). The substitute that passes now is `tests/app.rs`, which serves the documented
//! response shapes from a mock server.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use api::plan::PartnerPlans;
use billing::partner_api::PartnerCredentials;
use billing::{AppGid, PartnerOrganizationId, ShopGid};
use secrecy::SecretString;

#[tokio::test]
async fn live_the_partner_api_answers_the_active_subscription_query() {
    let get = |name: &str| std::env::var(name).ok();
    let (Some(org), Some(token), Some(app), Some(shop)) = (
        get("SHOPIFY_PARTNER_ORG_ID"),
        get("SHOPIFY_PARTNER_API_TOKEN"),
        get("SHOPIFY_APP_GID"),
        get("RAMPSMITH_LIVE_SHOP_GID"),
    ) else {
        eprintln!(
            "SKIPPED (LAUNCH.md section E, row 4): set SHOPIFY_PARTNER_ORG_ID, \
             SHOPIFY_PARTNER_API_TOKEN, SHOPIFY_APP_GID and RAMPSMITH_LIVE_SHOP_GID to ask \
             the real Partner API"
        );
        return;
    };
    let plans = PartnerPlans::new(
        PartnerCredentials {
            organization: PartnerOrganizationId::parse(&org).unwrap(),
            access_token: SecretString::from(token),
        },
        AppGid::parse(&app).unwrap(),
        None,
    );
    let subscription = plans
        .active_subscription(ShopGid::parse(&shop).unwrap())
        .await
        .unwrap();
    // A development store may have no subscription; either answer proves the round trip.
    eprintln!("active subscription present: {}", subscription.is_some());
}
