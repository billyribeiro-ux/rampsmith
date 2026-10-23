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
    state: WebhookState,
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
    let state = WebhookState::new(db, SecretString::from(SECRET));
    let router = webhooks::router(state.clone());
    Fixture {
        state,
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
            "customer": {"id": 191_167}, "orders_requested": [299_938],
            "data_request": {"id": 9999}
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

    // A different body is a new event. So is the same body under another non-compliance topic:
    // `shop/update` and `app/uninstalled` both carry the shop object, and an uninstall that
    // follows an identical shop/update must not be dropped as its replay (re-audit L-1). The
    // compliance topics, which a relabelled body could attack, share one claim (db test
    // `compliance_topics_share_one_replay_claim`).
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
    assert_eq!(events(&f.owner).await, 3);
    assert_eq!(process_jobs(&f.owner).await, 3);
    // The uninstall is a replay of itself, though, under any delivery id.
    let uninstall_again = Delivery::signed("app/uninstalled", "w-6", &body);
    assert_eq!(
        send(&f.router, uninstall_again.request("/webhooks/shopify"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 3);

    // After the replay window a body is accepted again.
    set_age(&f.owner, 25).await;
    let again = Delivery::signed("shop/update", "w-5", &body);
    assert_eq!(
        send(&f.router, again.request("/webhooks/shopify")).await.0,
        StatusCode::OK
    );
    assert_eq!(events(&f.owner).await, 4);
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
    let customer_redact = body_for("customers/redact");
    let redact = body_for("shop/redact");
    let mut redact_with_customer = redact.clone();
    redact_with_customer["customer"] = json!({"id": 1});
    let mut redact_with_orders = redact.clone();
    redact_with_orders["orders_to_redact"] = json!([1]);
    let mut redact_with_shop_object = redact.clone();
    redact_with_shop_object["myshopify_domain"] = json!(SHOP);
    let mut redact_without_id = redact.clone();
    redact_without_id.as_object_mut().unwrap().remove("shop_id");
    let mut request_without_orders = request.clone();
    request_without_orders
        .as_object_mut()
        .unwrap()
        .remove("orders_requested");
    let mut customer_redact_with_request = customer_redact.clone();
    customer_redact_with_request["data_request"] = json!({"id": 1});
    for (name, topic, body) in [
        // A signed customers/data_request relabelled shop/redact.
        (
            "data_request as shop/redact",
            "shop/redact",
            request.clone(),
        ),
        // A signed customers/redact relabelled shop/redact.
        (
            "customers/redact as shop/redact",
            "shop/redact",
            customer_redact.clone(),
        ),
        // A signed app/uninstalled relabelled shop/redact.
        (
            "uninstalled as shop/redact",
            "shop/redact",
            uninstall.clone(),
        ),
        ("redact with customer", "shop/redact", redact_with_customer),
        ("redact with orders", "shop/redact", redact_with_orders),
        (
            "redact with shop object",
            "shop/redact",
            redact_with_shop_object,
        ),
        ("redact without shop_id", "shop/redact", redact_without_id),
        (
            "redact as customers/redact",
            "customers/redact",
            redact.clone(),
        ),
        (
            "data_request as customers/redact",
            "customers/redact",
            request.clone(),
        ),
        (
            "customers/redact carrying a data request",
            "customers/redact",
            customer_redact_with_request,
        ),
        (
            "customers/redact as data_request",
            "customers/data_request",
            customer_redact.clone(),
        ),
        (
            "data_request without orders_requested",
            "customers/data_request",
            request_without_orders,
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

/// Shopify adds fields to payloads without a new version, so unknown keys are tolerated (L-4).
#[sqlx::test(migrations = "../db/migrations")]
async fn extra_fields_in_a_documented_payload_are_tolerated(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn).await;
    for (i, topic) in ["shop/redact", "customers/data_request", "customers/redact"]
        .iter()
        .enumerate()
    {
        let mut body = body_for(topic);
        body["a_field_shopify_added_later"] = json!({"nested": [1, 2]});
        let delivery = Delivery::signed(topic, &format!("x-{i}"), &body);
        assert_eq!(
            send(&f.router, delivery.request("/webhooks/shopify"))
                .await
                .0,
            StatusCode::OK,
            "{topic}"
        );
    }
    assert_eq!(events(&f.owner).await, 3);
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
async fn a_full_database_pool_answers_503_to_verified_deliveries_only(
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
    // An unsigned delivery never competes for it: it is refused for what it is.
    let mut unsigned = Delivery::signed("shop/update", "w-2", &named(1));
    unsigned.signature = None;
    let (status, _) = send(&router, unsigned.request("/webhooks/shopify")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_full_unverified_pool_answers_503_without_reading_the_body(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_login_pool(opts, conn).await;
    let state =
        WebhookState::new(Db::from_pool(pool), SecretString::from(SECRET)).with_max_unverified(0);
    let router = webhooks::router(state);
    let delivery = Delivery::signed("shop/update", "w-1", &named(1));
    let (status, _) = send(&router, delivery.request("/webhooks/shopify")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

/// Serves `router` on a local port and returns its address.
async fn serve(router: Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    addr
}

/// Opens a connection that announces `length` body bytes, sends only `sent` of them, and
/// stops. Returns the open stream.
async fn stalled(addr: std::net::SocketAddr, length: usize, sent: &[u8]) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt;
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let signature = webhooks::sign(SECRET, b"whatever").unwrap();
    let head = format!(
        "POST /webhooks/shopify HTTP/1.1\r\nHost: x\r\nX-Shopify-Hmac-SHA256: {signature}\r\n\
         X-Shopify-Topic: shop/update\r\nX-Shopify-Shop-Domain: {SHOP}\r\n\
         X-Shopify-Webhook-Id: slow\r\nContent-Type: application/json\r\n\
         Content-Length: {length}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(sent).await.unwrap();
    stream
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_stalled_body_is_cut_off_and_never_holds_a_database_permit(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    use tokio::io::AsyncReadExt;
    let f = fixture(opts, conn).await;
    // One database permit, three unverified slots: three stalled readers fill the unverified
    // pool; the database pool is untouched by them.
    let state = f.state.clone().with_max_in_flight(1).with_max_unverified(3);
    let router = webhooks::router(state);
    let addr = serve(router.clone()).await;

    let started = std::time::Instant::now();
    let mut slow = Vec::new();
    for _ in 0..3 {
        slow.push(stalled(addr, 100, b"{").await);
    }
    // While they stall the unverified pool is full: another connection is told to retry.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let mut late = stalled(addr, 0, b"").await;
    let mut text = String::new();
    let mut buf = [0_u8; 512];
    let n = tokio::time::timeout(std::time::Duration::from_secs(3), late.read(&mut buf))
        .await
        .expect("the full listener answered")
        .unwrap();
    text.push_str(&String::from_utf8_lossy(&buf[..n]));
    assert!(text.starts_with("HTTP/1.1 503"), "{text}");

    // Each stalled connection is answered 503 once the deadline passes, not left open.
    for stream in &mut slow {
        let mut buf = [0_u8; 512];
        let n = tokio::time::timeout(std::time::Duration::from_secs(4), stream.read(&mut buf))
            .await
            .expect("the stalled body was cut off")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
        assert!(text.starts_with("HTTP/1.1 503"), "{text}");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(4));

    // The slots are free again, and the one database permit was never taken: a real delivery
    // is stored.
    let delivery = Delivery::signed("shop/update", "w-ok", &named(5));
    let (status, _) = send(&router, delivery.request("/webhooks/shopify")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events(&f.owner).await, 1);
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
