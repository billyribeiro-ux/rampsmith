//! The Admin client against a real development store (LAUNCH.md section E, row 2).
//!
//! Skips, naming what it needs, until the founder's development store exists: set
//! `RAMPSMITH_LIVE_SHOP` (its `*.myshopify.com` domain) and `RAMPSMITH_LIVE_ADMIN_TOKEN` (an
//! offline access token with `read_products`). The substitute that passes now is
//! `tests/admin.rs`, which uses fixtures shaped as shopify.dev documents them.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use secrecy::SecretString;
use shopify::ShopDomain;
use shopify_admin::{AdminEndpoint, AdminFactory};

#[tokio::test]
async fn live_the_shop_and_a_page_of_products_are_read_from_a_development_store() {
    let (Some(shop), Some(token)) = (
        std::env::var("RAMPSMITH_LIVE_SHOP").ok(),
        std::env::var("RAMPSMITH_LIVE_ADMIN_TOKEN").ok(),
    ) else {
        eprintln!(
            "SKIPPED (LAUNCH.md section E, row 2): set RAMPSMITH_LIVE_SHOP and \
             RAMPSMITH_LIVE_ADMIN_TOKEN to read a real development store"
        );
        return;
    };
    let factory = AdminFactory::new(AdminEndpoint::Shopify, Duration::from_secs(20)).unwrap();
    let client = factory.client(
        &ShopDomain::parse(&shop).unwrap(),
        SecretString::from(token),
    );
    let info = client.shop().await.unwrap();
    assert_eq!(info.myshopify_domain, shop);
    assert!(info.gid.starts_with("gid://shopify/Shop/"));
    client.products(None).await.unwrap();
}
