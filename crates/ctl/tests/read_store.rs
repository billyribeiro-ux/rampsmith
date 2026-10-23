//! `shopify.read_store@1` (ADR-081): store data into `scan_inputs`, then the audit and plan jobs.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use contracts::ShopifyReadStore;
use crypto::KeyRing;
use ctl::jobs::scan_secret::{ScanSecrets, scan_context};
use queue::Failure;
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, method};
use wiremock::{Mock, ResponseTemplate};

mod support;

use support::world::{World, world};

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../shopify-admin/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The Admin API as the fixtures document it, with two product pages.
async fn mount_store(w: &World) {
    // A second product page: the first page's products under new ids, the last page.
    let mut second = fixture("products_page1");
    second["data"]["products"]["pageInfo"]["hasNextPage"] = json!(false);
    for (i, node) in second["data"]["products"]["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        node["id"] = json!(format!("gid://shopify/Product/9{i}"));
        node["handle"] = json!(format!("second-{i}"));
    }
    // The second page first: wiremock answers with the first mock that matches.
    Mock::given(method("POST"))
        .and(body_partial_json(json!({
            "operationName": "RampsmithProducts",
            "variables": { "after": "eyJsYXN0X2lkIjoxfQ==" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(second))
        .mount(&w.admin)
        .await;
    w.admin_operation("RampsmithProducts", fixture("products_page1"))
        .await;
    for (operation, name) in [
        ("RampsmithShop", "shop"),
        ("RampsmithCollections", "collections"),
        ("RampsmithPages", "pages"),
        ("RampsmithArticles", "articles"),
        ("RampsmithMenus", "menus"),
    ] {
        w.admin_operation(operation, fixture(name)).await;
    }
}

async fn read(w: &World, scan: Uuid) -> Result<(), Failure> {
    let job = w.job(
        ShopifyReadStore::QUEUE,
        ShopifyReadStore::SCHEMA,
        json!({"scan_id": scan, "site_id": w.site().await, "shop_id": w.session.shop_id.as_uuid()}),
    );
    w.jobs.dispatch(job).await
}

async fn read_as(w: &World, jobs: &ctl::jobs::Jobs, scan: Uuid) -> Result<(), Failure> {
    let job = w.job(
        ShopifyReadStore::QUEUE,
        ShopifyReadStore::SCHEMA,
        json!({"scan_id": scan, "site_id": w.site().await, "shop_id": w.session.shop_id.as_uuid()}),
    );
    jobs.dispatch(job).await
}

const MASTER: &str = "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SCAN_KEYS: &str = "scan1:Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA";

/// Saves `password` on the shop's site the way the api does: sealed under the master keys, bound
/// to the site.
async fn save_password(w: &World, master: &KeyRing, password: &str) {
    let site = w.site().await;
    let sealed = master
        .seal(
            password.as_bytes(),
            format!("sites/storefront_password/{site}").as_bytes(),
        )
        .unwrap();
    let (key_id, bytes) = sealed.into_parts();
    sqlx::query(
        "update sites set storefront_password_ct = $1, storefront_password_key_id = $2 where id = $3",
    )
    .bind(bytes)
    .bind(key_id.as_str())
    .bind(site)
    .execute(&w.owner)
    .await
    .unwrap();
}

async fn scan_secret(w: &World, scan: Uuid) -> Option<(String, Vec<u8>)> {
    let row: (Option<Vec<u8>>, Option<String>) = sqlx::query_as(
        "select storefront_password_ct, storefront_password_key_id from scans where id = $1",
    )
    .bind(scan)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    row.0.zip(row.1).map(|(bytes, id)| (id, bytes))
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_protected_stores_password_reaches_the_engine_sealed_for_that_scan_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    mount_store(&w).await;
    let master = KeyRing::parse(MASTER).unwrap();
    let scan_ring = KeyRing::parse(SCAN_KEYS).unwrap();
    save_password(&w, &master, "open-sesame, 12!").await;
    let armed = w
        .jobs
        .clone()
        .with_scan_secrets(ScanSecrets::new(master.clone(), scan_ring.clone()));

    // Not configured: the engine gets nothing and the read still succeeds.
    let plain = w.scan().await;
    read(&w, plain).await.unwrap();
    assert!(scan_secret(&w, plain).await.is_none());

    // Configured: a copy sealed under the scan key ring, bound to this scan.
    let scan = w.scan().await;
    read_as(&w, &armed, scan).await.unwrap();
    let (key_id, bytes) = scan_secret(&w, scan).await.expect("a sealed copy");
    assert_eq!(key_id, "scan1");
    let opened = scan_ring
        .open_string(
            &key_id,
            &bytes,
            &scan_context(domain::ScanId::from_uuid(scan)),
        )
        .unwrap();
    assert_eq!(opened.expose_secret(), "open-sesame, 12!");
    assert!(
        !bytes.windows(8).any(|w| w == b"open-ses"),
        "the plaintext is not in the stored bytes"
    );
    // It is bound to the scan, and the master keys do not open it.
    assert!(
        scan_ring
            .open_string(
                &key_id,
                &bytes,
                &scan_context(domain::ScanId::from_uuid(plain))
            )
            .is_err()
    );
    assert!(master.open_string(&key_id, &bytes, b"x").is_err());
    // Reading again (a retry) keeps one copy; the log of the run never carries the value.
    read_as(&w, &armed, scan).await.unwrap();
    assert!(scan_secret(&w, scan).await.is_some());

    // A failed scan drops it.
    let mut tx = w.db.tenant(w.session.tenant).await.unwrap();
    db::repo::scans::fail(
        &mut tx,
        domain::ScanId::from_uuid(scan),
        "store_unreachable",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(scan_secret(&w, scan).await.is_none());
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_password_that_cannot_be_opened_or_is_absent_hands_over_nothing_and_the_read_succeeds(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    mount_store(&w).await;
    let master = KeyRing::parse(MASTER).unwrap();
    let armed = w
        .jobs
        .clone()
        .with_scan_secrets(ScanSecrets::new(master, KeyRing::parse(SCAN_KEYS).unwrap()));
    // No saved password.
    let none = w.scan().await;
    read_as(&w, &armed, none).await.unwrap();
    assert!(scan_secret(&w, none).await.is_none());
    // Sealed under a key the ring no longer holds.
    let gone = KeyRing::parse("old:CwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSo").unwrap();
    save_password(&w, &gone, "lost").await;
    let lost = w.scan().await;
    read_as(&w, &armed, lost).await.unwrap();
    assert!(scan_secret(&w, lost).await.is_none());
}

async fn inputs(w: &World, scan: Uuid, kind: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select payload from scan_inputs where scan_id = $1 and kind = $2 order by seq",
    )
    .bind(scan)
    .bind(kind)
    .fetch_all(&w.owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_store_is_read_into_scan_inputs_and_the_audit_and_plan_are_queued(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    mount_store(&w).await;
    let scan = w.scan().await;

    read(&w, scan).await.unwrap();

    let products = inputs(&w, scan, "products").await;
    assert_eq!(products.len(), 2, "one batch per Admin page");
    let first = &products[0]["items"][0];
    assert_eq!(first["id"], "gid://shopify/Product/1");
    assert_eq!(first["handle"], "snow-globe");
    assert_eq!(first["template_suffix"], "landing");
    let media = first["media"].as_array().unwrap();
    assert!(
        media
            .iter()
            .all(|m| m["id"].as_str().unwrap().contains("MediaImage"))
    );
    assert!(media[0]["url"].as_str().unwrap().starts_with("https://"));
    assert!(
        media[0]["file_name"]
            .as_str()
            .is_some_and(|n| !n.contains('/'))
    );
    for kind in ["collections", "pages", "articles", "menus"] {
        assert_eq!(inputs(&w, scan, kind).await.len(), 1, "{kind}");
    }
    let shop = &inputs(&w, scan, "shop").await[0];
    assert_eq!(shop["primary_domain"], "supertoys.example");
    assert_eq!(shop["primary_locale"], "en");
    assert_eq!(
        shop["sampling"],
        json!({"mode": "home_plus", "pages": 5}),
        "no confirmed plan reads as Free"
    );
    let gid: Option<String> = sqlx::query_scalar("select shop_gid from shopify_shops")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(gid.as_deref(), Some("gid://shopify/Shop/548380009"));
    assert_eq!(shop["read"]["products"]["batches"], 2);
    assert_eq!(shop["read"]["products"]["truncated"], false);
    assert!(
        !shop.to_string().contains("shpat_"),
        "a token reached the payload"
    );

    // One audit job per audited batch, one plan, nothing for the shop input.
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'audit.data'")
            .await,
        6
    );
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'scan.plan'")
            .await,
        1
    );
    let site: (Option<String>, Vec<String>, Option<String>) =
        sqlx::query_as("select primary_domain, locales, name from shopify_shops")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(site.0.as_deref(), Some("supertoys.example"));
    assert_eq!(site.1, ["en", "fr"]);
    assert_eq!(
        site.2.as_deref(),
        Some("Super Toys"),
        "the shop's name is stored for the overview"
    );

    // Reading again (a retry) replaces the batches and queues nothing twice.
    read(&w, scan).await.unwrap();
    assert_eq!(w.count("select count(*) from scan_inputs").await, 7);
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'audit.data'")
            .await,
        6
    );
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'scan.plan'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shopify_outage_midway_retries_and_stores_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // The shop and products read fine; the collections query fails.
    w.admin_operation("RampsmithCollections", fixture("internal_error"))
        .await;
    mount_store(&w).await;
    let scan = w.scan().await;
    let Err(Failure::Retryable(_)) = read(&w, scan).await else {
        panic!("a Shopify outage should be retried");
    };
    assert_eq!(w.count("select count(*) from scan_inputs").await, 0);
    assert_eq!(
        w.count("select count(*) from jobs where queue in ('audit.data', 'scan.plan')")
            .await,
        0
    );
    assert_eq!(status(&w, scan).await, "queued");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_grant_shopify_rejects_fails_the_scan_for_good(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    w.admin_answers(
        401,
        json!({"errors": "[API] Invalid API key or access token"}),
    )
    .await;
    let scan = w.scan().await;
    let Err(Failure::Permanent(error)) = read(&w, scan).await else {
        panic!("a rejected token should fail permanently");
    };
    assert_eq!(error.code, "token_rejected");
    assert_eq!(status(&w, scan).await, "failed");
    let code: Option<String> = sqlx::query_scalar("select error_code from scans where id = $1")
        .bind(scan)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(code.as_deref(), Some("token_rejected"));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_without_a_token_a_stranger_scan_and_a_finished_scan_are_handled(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // A scan that already finished is not read again.
    let done = w.scan().await;
    sqlx::query("update scans set status = 'cancelled' where id = $1")
        .bind(done)
        .execute(&w.owner)
        .await
        .unwrap();
    read(&w, done).await.unwrap();
    assert!(w.admin.received_requests().await.unwrap().is_empty());

    // A scan id that is not this tenant's.
    let Err(Failure::Permanent(error)) = read(&w, Uuid::now_v7()).await else {
        panic!("an unknown scan should fail");
    };
    assert_eq!(error.code, "scan_not_found");

    // No token: the shop is not connected, and the scan fails.
    sqlx::query("delete from shopify_tokens")
        .execute(&w.owner)
        .await
        .unwrap();
    let scan = w.scan().await;
    let Err(Failure::Permanent(error)) = read(&w, scan).await else {
        panic!("a shop without a token should fail");
    };
    assert_eq!(error.code, "shop_not_connected");
    assert_eq!(status(&w, scan).await, "failed");
}

async fn status(w: &World, scan: Uuid) -> String {
    sqlx::query_scalar("select status from scans where id = $1")
        .bind(scan)
        .fetch_one(&w.owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_shop_input_carries_the_confirmed_plans_sampling(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    mount_store(&w).await;
    let (tenant, shop) = (w.session.tenant.as_uuid(), w.session.shop_id.as_uuid());
    let scan = w.scan().await;
    for (plan, expected) in [
        (
            "starter",
            json!({"mode": "per_template", "samples": 3, "every_variant": false}),
        ),
        (
            "growth",
            json!({"mode": "per_template", "samples": 10, "every_variant": false}),
        ),
        (
            "pro",
            json!({"mode": "per_template", "samples": 25, "every_variant": true}),
        ),
    ] {
        sqlx::query(
            "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval)
             values ($1, $2, 'paid', $3, 'monthly')
             on conflict (shop_id) do update set plan = excluded.plan",
        )
        .bind(shop)
        .bind(tenant)
        .bind(plan)
        .execute(&w.owner)
        .await
        .unwrap();
        read(&w, scan).await.unwrap();
        assert_eq!(
            inputs(&w, scan, "shop").await[0]["sampling"],
            expected,
            "{plan}"
        );
    }
}
