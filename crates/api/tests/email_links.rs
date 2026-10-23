//! Email links and preferences (ADR-274, ADR-275): the web app's two public pages, the RFC 8058
//! one-click route on the webhook listener, and the App Home settings, against a real database.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use api::AppState;
use api::email_link::{Claims, EmailLinks, LinkKeys, OneClickState, Purpose};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use crypto::KeyRing;
use db::Db;
use db::repo::email::OptOutCategory;
use domain::{ShopId, TenantId};
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use secrecy::SecretString;
use serde_json::{Value, json};
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::ShopifyAuth;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

mod support;

use support::app_login_pool;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_api_test";
const SHOP: &str = "demo-store.myshopify.com";
const STAFF: &str = "42";
const KEYS: &str = "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const LINK_KEYS: &str = "e1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const OWNER_ADDRESS: &str = "owner@demo-store.example";
const APP: &str = "https://app.rampsmith.example";

struct Harness {
    state: AppState,
    one_click: Router,
    owner: PgPool,
    tenant: Uuid,
    shop: Uuid,
    _shopify: MockServer,
}

fn id_token() -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    encode(
        &Header::new(Algorithm::HS256),
        &json!({
            "iss": format!("https://{SHOP}/admin"), "dest": format!("https://{SHOP}"),
            "aud": CLIENT_ID, "exp": now + 60, "nbf": now - 1, "iat": now - 1,
            "jti": "j", "sid": "s", "sub": STAFF
        }),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

fn links() -> EmailLinks {
    EmailLinks::new(LinkKeys::parse(LINK_KEYS).unwrap(), APP)
}

async fn harness(opts: PgPoolOptions, conn: PgConnectOptions, configured: bool) -> Harness {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "shpat_a", "scope": "read_products,write_products",
            "expires_in": 3600, "refresh_token": "shprt_r", "refresh_token_expires_in": 7_776_000
        })))
        .mount(&shopify)
        .await;
    let db = Db::from_pool(app_login_pool(opts, conn).await);
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse(KEYS).unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            Duration::from_secs(2),
        )
        .unwrap(),
    );
    let mut state = AppState::new(db.clone()).with_shopify(auth);
    if configured {
        state = state.with_email_links(links());
    }
    let installed = api::app(state.clone())
        .oneshot(
            Request::post("/v1/shopify/session")
                .header(header::AUTHORIZATION, format!("Bearer {}", id_token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(installed.status(), StatusCode::OK);
    let (tenant, shop): (Uuid, Uuid) =
        sqlx::query_as("select tenant_id, id from shopify_shops where shop_domain = $1")
            .bind(SHOP)
            .fetch_one(&owner)
            .await
            .unwrap();
    Harness {
        one_click: api::email_link::one_click_router(OneClickState::new(db, links())),
        state,
        owner,
        tenant,
        shop,
        _shopify: shopify,
    }
}

impl Harness {
    async fn contact(&self) {
        sqlx::query(
            "insert into shop_contacts (shop_id, tenant_id, email, store_name)
             values ($1, $2, $3, 'Demo Outfitters')",
        )
        .bind(self.shop)
        .bind(self.tenant)
        .bind(OWNER_ADDRESS)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    async fn hash(&self) -> [u8; 32] {
        let bytes: Vec<u8> = sqlx::query_scalar("select email_address_hash($1, $2)")
            .bind(self.tenant)
            .bind(OWNER_ADDRESS)
            .fetch_one(&self.owner)
            .await
            .unwrap();
        bytes.try_into().unwrap()
    }

    fn claims(&self, hash: [u8; 32], category: Option<OptOutCategory>, expires_at: u32) -> Claims {
        Claims {
            purpose: if category.is_some() {
                Purpose::Unsubscribe
            } else {
                Purpose::Preferences
            },
            category,
            expires_at,
            tenant: TenantId::from_uuid(self.tenant),
            shop: ShopId::from_uuid(self.shop),
            address_hash: hash,
        }
    }

    fn token(&self, hash: [u8; 32], category: Option<OptOutCategory>) -> String {
        let expires =
            u32::try_from(time::OffsetDateTime::now_utc().unix_timestamp() + 3600).unwrap();
        links().keys().mint(&self.claims(hash, category, expires))
    }

    async fn opt_outs(&self) -> Vec<String> {
        sqlx::query_scalar("select category from email_opt_outs where tenant_id = $1 order by 1")
            .bind(self.tenant)
            .fetch_all(&self.owner)
            .await
            .unwrap()
    }
}

async fn send(router: Router, request: Request<Body>) -> (StatusCode, header::HeaderMap, Value) {
    let res = router.oneshot(request).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn json_post(uri: &str, body: &Value) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn session(verb: &str, body: Option<&Value>) -> Request<Body> {
    let request = Request::builder()
        .method(verb)
        .uri("/v1/shopify/email-preferences")
        .header(header::AUTHORIZATION, format!("Bearer {}", id_token()));
    match body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap()
}

fn one_click_post(token: &str, body: &'static str) -> Request<Body> {
    Request::post(format!("/webhooks/email/unsubscribe?t={token}"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(body))
        .unwrap()
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_link_is_read_before_anything_changes(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = harness(opts, conn, true).await;
    h.contact().await;
    let hash = h.hash().await;
    let token = h.token(hash, Some(OptOutCategory::Notification));
    let (status, _, body) = send(
        api::app(h.state.clone()),
        json_post("/v1/email/links/inspect", &json!({"token": token})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["purpose"], "unsubscribe");
    assert_eq!(
        body["categories"],
        json!([{"category": "notification", "enabled": true}])
    );
    assert!(
        h.opt_outs().await.is_empty(),
        "reading a link changes nothing"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_forged_expired_or_garbled_link_is_refused_and_changes_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    h.contact().await;
    let hash = h.hash().await;
    let good = h.token(hash, Some(OptOutCategory::Notification));
    let mut forged = good.clone().into_bytes();
    let last = forged.len() - 3;
    forged[last] = if forged[last] == b'A' { b'B' } else { b'A' };
    let forged = String::from_utf8(forged).unwrap();
    let expired =
        links()
            .keys()
            .mint(&h.claims(hash, Some(OptOutCategory::Notification), 1_000_000_000));
    for (token, expect) in [
        (forged.as_str(), "invalid"),
        (expired.as_str(), "expired"),
        ("not-a-token", "invalid"),
        ("", "invalid"),
    ] {
        let (status, _, body) = send(
            api::app(h.state.clone()),
            json_post("/v1/email/links/inspect", &json!({"token": token})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{token}");
        assert_eq!(body["status"], expect, "{token}");
        let (status, _, body) = send(
            api::app(h.state.clone()),
            json_post(
                "/v1/email/links/preference",
                &json!({"token": token, "category": "notification", "enabled": false}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{token}");
        assert_eq!(body["status"], expect, "{token}");
        let (status, _, _) = send(
            h.one_click.clone(),
            one_click_post(token, "List-Unsubscribe=One-Click"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{token}");
    }
    assert!(
        h.opt_outs().await.is_empty(),
        "a refused link changed a preference"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_link_switches_only_what_it_was_made_for_and_records_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    h.contact().await;
    let hash = h.hash().await;
    let unsubscribe = h.token(hash, Some(OptOutCategory::Notification));
    let change = |token: &str, category: &str, enabled: bool| {
        json_post(
            "/v1/email/links/preference",
            &json!({"token": token, "category": category, "enabled": enabled}),
        )
    };
    // A link for notifications cannot touch marketing.
    let (status, _, _) = send(
        api::app(h.state.clone()),
        change(&unsubscribe, "marketing", false),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(h.opt_outs().await.is_empty());

    let (status, _, body) = send(
        api::app(h.state.clone()),
        change(&unsubscribe, "notification", false),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["categories"],
        json!([{"category": "notification", "enabled": false}])
    );
    assert_eq!(h.opt_outs().await, vec!["notification".to_owned()]);
    // Doing it twice leaves one row and one audit entry.
    send(
        api::app(h.state.clone()),
        change(&unsubscribe, "notification", false),
    )
    .await;
    assert_eq!(h.opt_outs().await.len(), 1);
    let entries: Vec<(String, Value)> = sqlx::query_as(
        "select action, data from audit_log where tenant_id = $1 and action like 'email.%'",
    )
    .bind(h.tenant)
    .fetch_all(&h.owner)
    .await
    .unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].0, "email.opted_out");
    assert!(
        !entries[0].1.to_string().contains("demo-store.example"),
        "the audit entry names an address"
    );

    // Taking it back works from the same link.
    let (_, _, body) = send(
        api::app(h.state.clone()),
        change(&unsubscribe, "notification", true),
    )
    .await;
    assert_eq!(body["categories"][0]["enabled"], true);
    assert!(h.opt_outs().await.is_empty());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn one_click_unsubscribes_on_a_post_with_the_rfc_8058_body_and_a_get_only_redirects(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    h.contact().await;
    let token = h.token(h.hash().await, Some(OptOutCategory::Notification));

    // A GET (a link scanner, a person) changes nothing and goes to the page.
    let (status, headers, _) = send(
        h.one_click.clone(),
        Request::get(format!("/webhooks/email/unsubscribe?t={token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(
        headers.get(header::LOCATION).unwrap().to_str().unwrap(),
        format!("{APP}/email/unsubscribe?t={token}")
    );
    assert!(h.opt_outs().await.is_empty(), "a GET changed a preference");

    // A POST without the RFC 8058 body does nothing either.
    let (status, _, _) = send(h.one_click.clone(), one_click_post(&token, "hello=world")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(h.opt_outs().await.is_empty());

    let (status, _, _) = send(
        h.one_click.clone(),
        one_click_post(&token, "List-Unsubscribe=One-Click"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h.opt_outs().await, vec!["notification".to_owned()]);

    // A preferences token is not an unsubscribe token.
    let prefs = h.token(h.hash().await, None);
    let (status, _, _) = send(
        h.one_click.clone(),
        one_click_post(&prefs, "List-Unsubscribe=One-Click"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_preferences_link_covers_every_category_a_merchant_can_change(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    h.contact().await;
    let token = h.token(h.hash().await, None);
    let (_, _, body) = send(
        api::app(h.state.clone()),
        json_post("/v1/email/links/inspect", &json!({"token": token})),
    )
    .await;
    assert_eq!(body["purpose"], "preferences");
    assert_eq!(
        body["categories"],
        json!([{"category": "notification", "enabled": true}])
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_link_keys_the_pages_answer_unavailable(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, false).await;
    let (status, _, _) = send(
        api::app(h.state.clone()),
        json_post("/v1/email/links/inspect", &json!({"token": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_app_home_switch_follows_the_address_the_mail_goes_to(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    // Needs a session.
    let (status, _, _) = send(
        api::app(h.state.clone()),
        Request::get("/v1/shopify/email-preferences")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // No address on file: nothing to switch.
    let (_, _, body) = send(api::app(h.state.clone()), session("GET", None)).await;
    assert_eq!(body["address_known"], false);
    let off = json!({"category": "notification", "enabled": false});
    let (status, _, _) = send(api::app(h.state.clone()), session("PUT", Some(&off))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    h.contact().await;
    let (_, _, body) = send(api::app(h.state.clone()), session("GET", None)).await;
    assert_eq!(body["address_known"], true);
    assert_eq!(body["categories"][0]["enabled"], true);

    let (status, _, body) = send(api::app(h.state.clone()), session("PUT", Some(&off))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["categories"][0]["enabled"], false);
    assert_eq!(h.opt_outs().await, vec!["notification".to_owned()]);

    // Marketing is not a merchant's switch (nothing is sent in R1); security mail cannot be off.
    for category in ["marketing", "security", "transactional", "nonsense"] {
        let (status, _, _) = send(
            api::app(h.state.clone()),
            session(
                "PUT",
                Some(&json!({"category": category, "enabled": false})),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{category}");
    }

    let on = json!({"category": "notification", "enabled": true});
    let (_, _, body) = send(api::app(h.state.clone()), session("PUT", Some(&on))).await;
    assert_eq!(body["categories"][0]["enabled"], true);
    assert!(h.opt_outs().await.is_empty());
}
