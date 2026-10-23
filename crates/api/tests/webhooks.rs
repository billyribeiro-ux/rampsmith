//! The webhook listener (ADR-080, ADR-182): signature before anything else, deduplication on
//! the delivery id and on the body's digest, and nothing served but `/webhooks/*`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use api::webhooks::{self, ACCEPTED_TOPICS, MAX_BODY_BYTES, WebhookState};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use db::Db;
use domain::{Platform, TenantId, TenantKind};
use http_body_util::BodyExt;
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

mod support;

use support::app_login_pool;

const SECRET: &str = "shpss_webhook_test";
const SHOP: &str = "demo-store.myshopify.com";

struct Fixture {
    router: Router,
    owner: PgPool,
    tenant: TenantId,
}

async fn fixture(opts: PgPoolOptions, conn: PgConnectOptions) -> Fixture {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = app_login_pool(opts, conn).await;
    let db = Db::from_pool(pool);
    let tenant = TenantId::new();
    let mut tx = db.tenant(tenant).await.unwrap();
    db::repo::tenants::create(&mut tx, TenantKind::ShopifyStore)
        .await
        .unwrap();
    let site = db::repo::sites::create(
        &mut tx,
        &db::repo::sites::NewSite {
            platform: Platform::Shopify,
            base_url: format!("https://{SHOP}"),
            primary_locale: "en".to_owned(),
        },
    )
    .await
    .unwrap();
    db::repo::shopify::install(
        &mut tx,
        &db::repo::shopify::NewShop {
            site_id: site.id,
            shop_domain: SHOP.to_owned(),
            scopes: vec!["read_products".to_owned()],
            api_version: "2026-10".to_owned(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let router = webhooks::router(WebhookState::new(db, SecretString::from(SECRET)));
    Fixture {
        router,
        owner,
        tenant,
    }
}

/// A shop object, as `shop/update` and `app/uninstalled` carry it.
fn named(id: u32) -> Value {
    json!({"id": id, "myshopify_domain": SHOP})
}

/// A body shaped like Shopify's documented payload for `topic`.
fn body_for(topic: &str) -> Value {
    match topic {
        "shop/redact" => json!({"shop_id": 954_889, "shop_domain": SHOP}),
        "customers/data_request" => json!({
            "shop_id": 954_889, "shop_domain": SHOP,
            "customer": {"id": 191_167}, "data_request": {"id": 9999}
        }),
        "customers/redact" => json!({
            "shop_id": 954_889, "shop_domain": SHOP,
            "customer": {"id": 191_167}, "orders_to_redact": [299_938]
        }),
        "app/uninstalled" => named(2),
        _ => named(1),
    }
}

async fn set_age(owner: &PgPool, hours: i32) {
    sqlx::query(
        "update webhook_digests set claimed_at = now() - make_interval(hours => $1),
                                    expires_at = expires_at - make_interval(hours => $1)",
    )
    .bind(hours)
    .execute(owner)
    .await
    .unwrap();
}

struct Delivery {
    body: Vec<u8>,
    topic: Option<&'static str>,
    shop: Option<&'static str>,
    id: Option<String>,
    signature: Option<String>,
}

impl Delivery {
    fn signed(topic: &'static str, id: &str, body: &Value) -> Self {
        let body = serde_json::to_vec(body).unwrap();
        Self {
            signature: webhooks::sign(SECRET, &body),
            body,
            topic: Some(topic),
            shop: Some(SHOP),
            id: Some(id.to_owned()),
        }
    }

    fn request(&self, path: &str) -> Request<Body> {
        let mut request = Request::post(path);
        if let Some(signature) = &self.signature {
            request = request.header("X-Shopify-Hmac-SHA256", signature);
        }
        if let Some(topic) = self.topic {
            request = request.header("X-Shopify-Topic", topic);
        }
        if let Some(shop) = self.shop {
            request = request.header("X-Shopify-Shop-Domain", shop);
        }
        if let Some(id) = &self.id {
            request = request.header("X-Shopify-Webhook-Id", id);
        }
        request.body(Body::from(self.body.clone())).unwrap()
    }
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, String) {
    let res = router.clone().oneshot(request).await.unwrap();
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&body).into_owned())
}

async fn events(owner: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from webhook_events")
        .fetch_one(owner)
        .await
        .unwrap()
}

async fn process_jobs(owner: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from jobs where queue = 'webhook.process'")
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_unsigned_or_wrongly_signed_delivery_is_401_and_stores_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = json!({"id": 1, "myshopify_domain": SHOP});
    let good = Delivery::signed("app/uninstalled", "w-1", &body);

    let mut none = Delivery::signed("app/uninstalled", "w-1", &body);
    none.signature = None;
    let mut garbage = Delivery::signed("app/uninstalled", "w-1", &body);
    garbage.signature = Some("not base64 !!!".to_owned());
    let mut other_body = Delivery::signed("app/uninstalled", "w-1", &named(2));
    other_body.body = good.body.clone();
    let mut other_secret = Delivery::signed("app/uninstalled", "w-1", &body);
    other_secret.signature = webhooks::sign("another-secret", &other_secret.body);
    let mut truncated = Delivery::signed("app/uninstalled", "w-1", &body);
    truncated.signature = truncated.signature.map(|s| s[..s.len() - 4].to_owned());
    let mut empty = Delivery::signed("app/uninstalled", "w-1", &body);
    empty.signature = Some(String::new());

    for (name, delivery) in [
        ("missing", none),
        ("garbage", garbage),
        ("other body", other_body),
        ("other secret", other_secret),
        ("truncated", truncated),
        ("empty", empty),
    ] {
        let (status, text) = send(&f.router, delivery.request("/webhooks/shopify")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{name}");
        assert!(
            text.contains("problem") || text.contains("unauthenticated"),
            "{name}: {text}"
        );
    }
    assert_eq!(events(&f.owner).await, 0);
    assert_eq!(process_jobs(&f.owner).await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_signed_delivery_is_stored_with_its_digest_and_enqueued_in_the_same_transaction(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = json!({"id": 548_380_009, "myshopify_domain": SHOP});
    let delivery = Delivery::signed("app/uninstalled", "w-1", &body);
    let (status, text) = send(&f.router, delivery.request("/webhooks/shopify")).await;
    assert_eq!((status, text.as_str()), (StatusCode::OK, ""));

    let row: (uuid::Uuid, String, String, Value, Vec<u8>, uuid::Uuid) = sqlx::query_as(
        "select id, topic, external_id, body, body_sha256, tenant_id from webhook_events",
    )
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(row.1, "app/uninstalled");
    assert_eq!(row.2, "w-1");
    assert_eq!(row.3, body);
    assert_eq!(row.4, Sha256::digest(&delivery.body).to_vec());
    assert_eq!(row.5, f.tenant.as_uuid());

    let job: (String, Value, Option<uuid::Uuid>, String) = sqlx::query_as(
        "select payload_schema, payload, tenant_id, state from jobs where queue = 'webhook.process'",
    )
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(job.0, "webhook.process@1");
    assert_eq!(job.1, json!({"event_id": row.0}));
    assert_eq!(job.2, Some(f.tenant.as_uuid()));
    assert_eq!(job.3, "ready");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn repeats_by_delivery_id_and_by_body_digest_are_acknowledged_not_processed_again(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = named(1);
    let first = Delivery::signed("shop/update", "w-1", &body);
    assert_eq!(
        send(&f.router, first.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    // A retry: the same delivery id.
    assert_eq!(
        send(&f.router, first.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    // A replay: the id header is not signed, so an attacker (or a buggy proxy) can change it.
    let replay = Delivery::signed("shop/update", "w-2", &body);
    assert_eq!(
        send(&f.router, replay.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 1);
    assert_eq!(process_jobs(&f.owner).await, 1);

    // A different body is a new event; the same body under another topic is a replay too
    // (the topic header is unsigned, audit H1).
    let changed = Delivery::signed("shop/update", "w-3", &named(2));
    assert_eq!(
        send(&f.router, changed.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    let other_topic = Delivery::signed("app/uninstalled", "w-4", &body);
    assert_eq!(
        send(&f.router, other_topic.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 2);
    assert_eq!(process_jobs(&f.owner).await, 2);

    // After the replay window a body is accepted again.
    set_age(&f.owner, 25).await;
    let again = Delivery::signed("shop/update", "w-5", &body);
    assert_eq!(
        send(&f.router, again.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 3);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_redact_body_stays_a_replay_for_longer_than_other_topics(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = body_for("shop/redact");
    let first = Delivery::signed("shop/redact", "w-1", &body);
    assert_eq!(
        send(&f.router, first.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    // 30 hours later, under a new id: still a replay (the 24 hour window would let it in).
    set_age(&f.owner, 30).await;
    let replay = Delivery::signed("shop/redact", "w-2", &body);
    assert_eq!(
        send(&f.router, replay.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 1);
    // 41 hours after the first, under 48 hours of a genuine repeat: accepted as new.
    set_age(&f.owner, 11).await;
    let genuine = Delivery::signed("shop/redact", "w-3", &body);
    assert_eq!(
        send(&f.router, genuine.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 2);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_replays_of_one_body_store_one_event(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = named(77);
    let mut sends = Vec::new();
    for i in 0..12 {
        let router = f.router.clone();
        let delivery = Delivery::signed("shop/update", &format!("c-{i}"), &body);
        sends.push(tokio::spawn(async move {
            send(&router, delivery.request("/webhooks/shopify")).await.0
        }));
    }
    for handle in sends {
        assert_eq!(handle.await.unwrap(), StatusCode::OK);
    }
    assert_eq!(events(&f.owner).await, 1);
    assert_eq!(process_jobs(&f.owner).await, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_body_that_is_not_shaped_like_its_topic_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let uninstall = named(1);
    let request = body_for("customers/data_request");
    let redact = body_for("shop/redact");
    let mut wide_redact = redact.clone();
    wide_redact["extra"] = json!(1);
    for (name, topic, body) in [
        // A signed customers/data_request relabelled shop/redact.
        (
            "data_request as shop/redact",
            "shop/redact",
            request.clone(),
        ),
        // A signed app/uninstalled relabelled shop/redact.
        (
            "uninstalled as shop/redact",
            "shop/redact",
            uninstall.clone(),
        ),
        ("redact with extra keys", "shop/redact", wide_redact),
        (
            "redact as customers/redact",
            "customers/redact",
            redact.clone(),
        ),
        (
            "redact as app/uninstalled",
            "app/uninstalled",
            redact.clone(),
        ),
        ("request as shop/update", "shop/update", request.clone()),
        ("array", "shop/update", json!([1, 2])),
    ] {
        let delivery = Delivery::signed(topic, "w-x", &body);
        let (status, _) = send(&f.router, delivery.request("/webhooks/shopify")).await;
        // A bare array names no shop (401); the rest are well-signed bodies for the wrong topic.
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::UNAUTHORIZED,
            "{name}: {status}"
        );
    }
    assert_eq!(events(&f.owner).await, 0);
    assert_eq!(process_jobs(&f.owner).await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_shop_redact_naming_another_shop_id_than_the_stored_one_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    sqlx::query("update shopify_shops set shop_gid = 'gid://shopify/Shop/954889'")
        .execute(&f.owner)
        .await
        .unwrap();
    let wrong = Delivery::signed(
        "shop/redact",
        "w-1",
        &json!({"shop_id": 1, "shop_domain": SHOP}),
    );
    assert_eq!(
        send(&f.router, wrong.request("/webhooks/shopify")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(events(&f.owner).await, 0);
    // The right id is stored. (The refused one left no digest behind.)
    let right = Delivery::signed("shop/redact", "w-2", &body_for("shop/redact"));
    assert_eq!(
        send(&f.router, right.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn every_compliance_topic_and_app_uninstalled_are_stored(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    assert_eq!(
        ACCEPTED_TOPICS,
        [
            "app/uninstalled",
            "customers/data_request",
            "customers/redact",
            "shop/redact",
            "shop/update"
        ]
    );
    for (i, topic) in ACCEPTED_TOPICS.iter().enumerate() {
        let delivery = Delivery::signed(topic, &format!("w-{i}"), &body_for(topic));
        assert_eq!(
            send(&f.router, delivery.request("/webhooks/shopify"))
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(events(&f.owner).await, 5);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn unknown_shops_and_unhandled_topics_are_acknowledged_without_storing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let mut stranger = Delivery::signed(
        "app/uninstalled",
        "w-1",
        &json!({"id": 1, "myshopify_domain": "nobody.myshopify.com"}),
    );
    stranger.shop = Some("nobody.myshopify.com");
    assert_eq!(
        send(&f.router, stranger.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    let unhandled = Delivery::signed("products/update", "w-2", &named(1));
    assert_eq!(
        send(&f.router, unhandled.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_signed_delivery_with_bad_headers_or_body_is_400(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let body = named(1);
    let mut no_topic = Delivery::signed("shop/update", "w-1", &body);
    no_topic.topic = None;
    let mut bad_topic = Delivery::signed("SHOP/Update", "w-1", &body);
    bad_topic.topic = Some("SHOP/Update");
    let mut no_shop = Delivery::signed("shop/update", "w-1", &body);
    no_shop.shop = None;
    let mut bad_shop = Delivery::signed("shop/update", "w-1", &body);
    bad_shop.shop = Some("evil.example.com");
    let mut no_id = Delivery::signed("shop/update", "w-1", &body);
    no_id.id = None;
    let mut not_json = Delivery::signed("shop/update", "w-1", &body);
    not_json.body = b"<xml/>".to_vec();
    not_json.signature = webhooks::sign(SECRET, &not_json.body);
    for (name, delivery) in [
        ("no topic", no_topic),
        ("bad topic", bad_topic),
        ("no shop", no_shop),
        ("bad shop", bad_shop),
        ("no id", no_id),
        ("not json", not_json),
    ] {
        let (status, _) = send(&f.router, delivery.request("/webhooks/shopify")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    assert_eq!(events(&f.owner).await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_oversized_body_is_refused_before_it_is_verified(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    let mut huge = Delivery::signed("shop/update", "w-1", &named(0));
    huge.body = vec![b' '; MAX_BODY_BYTES + 1];
    huge.signature = webhooks::sign(SECRET, &huge.body);
    let (status, _) = send(&f.router, huge.request("/webhooks/shopify")).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(events(&f.owner).await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn only_webhook_paths_exist_on_this_listener(opts: PgPoolOptions, conn: PgConnectOptions) {
    let f = fixture(opts, conn).await;
    for path in [
        "/",
        "/healthz",
        "/readyz",
        "/openapi.json",
        "/api",
        "/v1",
        "/v1/shopify/session",
        "/v1/shopify/overview",
        "/webhooks",
        "/webhooks/github",
        "/webhooks/stripe",
        "/webhooks/shopify/extra",
    ] {
        for method in ["GET", "POST"] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap();
            let (status, _) = send(&f.router, request).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        }
    }
    // Only POST is served on the Shopify path; a GET is a 404 like everything else.
    let get = Request::get("/webhooks/shopify")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&f.router, get).await.0, StatusCode::NOT_FOUND);
    // The image smoke test's own probes.
    let unsigned = Request::post("/webhooks/shopify")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&f.router, unsigned).await.0, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_full_listener_answers_503_without_reading_the_body(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_login_pool(opts, conn).await;
    let state =
        WebhookState::new(Db::from_pool(pool), SecretString::from(SECRET)).with_max_in_flight(0);
    let router = webhooks::router(state);
    let delivery = Delivery::signed("shop/update", "w-1", &named(1));
    let (status, _) = send(&router, delivery.request("/webhooks/shopify")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_signature_is_checked_before_the_database_is_touched() {
    // A database nobody can reach: an unsigned request still gets its 401, and a signed one
    // for an unreachable database is a 500 that makes Shopify retry, not a 200.
    let db = Db::connect_lazy("postgres://nobody@127.0.0.1:1/none", 1).unwrap();
    let router = webhooks::router(WebhookState::new(db, SecretString::from(SECRET)));
    let mut unsigned = Delivery::signed("shop/update", "w-1", &named(1));
    unsigned.signature = None;
    assert_eq!(
        send(&router, unsigned.request("/webhooks/shopify")).await.0,
        StatusCode::UNAUTHORIZED
    );
    let signed = Delivery::signed("shop/update", "w-1", &named(1));
    let status = send(&router, signed.request("/webhooks/shopify")).await.0;
    assert!(status.is_server_error(), "{status}");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_body_that_names_another_shop_than_the_header_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    // A genuine, signed shop/redact of another shop, replayed with this shop's domain header.
    let mut forged = Delivery::signed(
        "shop/redact",
        "w-1",
        &json!({"shop_id": 9, "shop_domain": "victim.myshopify.com"}),
    );
    forged.shop = Some(SHOP);
    assert_eq!(
        send(&f.router, forged.request("/webhooks/shopify")).await.0,
        StatusCode::UNAUTHORIZED
    );
    // A body that names no shop at all.
    let silent = Delivery::signed("shop/redact", "w-2", &json!({"shop_id": 9}));
    assert_eq!(
        send(&f.router, silent.request("/webhooks/shopify")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(events(&f.owner).await, 0);
}
