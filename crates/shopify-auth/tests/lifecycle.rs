//! The offline-token lifecycle against PostgreSQL and a mock Shopify (ADR-022).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::time::Duration as StdDuration;

use crypto::KeyRing;
use db::Db;
use db::repo::shopify as shops;
use domain::ShopStatus;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use shopify::{SessionTokenError, SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::{AuthError, RefreshError, RefreshOutcome, ShopifyAuth};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};
use time::{Duration, OffsetDateTime};
use wiremock::matchers::method;
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_lifecycle_secret";
const KEYS: &str = "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SHOP: &str = "demo-store.myshopify.com";

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_792_300_000).unwrap()
}

fn id_token(shop: &str, at: OffsetDateTime) -> String {
    let t = at.unix_timestamp();
    let claims = json!({
        "iss": format!("https://{shop}/admin"),
        "dest": format!("https://{shop}"),
        "aud": CLIENT_ID,
        "sub": "42",
        "exp": t + 60,
        "nbf": t - 1,
        "iat": t - 1,
        "jti": format!("jti-{t}"),
        "sid": "sid",
    });
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

fn token_body(n: u32) -> serde_json::Value {
    json!({
        "access_token": format!("shpat_access_{n}"),
        "scope": "read_products,read_themes",
        "expires_in": 3600,
        "refresh_token": format!("shprt_refresh_{n}"),
        "refresh_token_expires_in": 7_776_000
    })
}

/// Matches a form body field.
struct Field(&'static str, String);

impl Match for Field {
    fn matches(&self, request: &Request) -> bool {
        let form: HashMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        form.get(self.0) == Some(&self.1)
    }
}

async fn app_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    opts.after_connect(|c, _| {
        Box::pin(async move {
            c.execute("set role rampsmith_app").await?;
            Ok(())
        })
    })
    .connect_with(conn)
    .await
    .unwrap()
}

struct World {
    auth: ShopifyAuth,
    db: Db,
    owner: PgPool,
    keys: KeyRing,
    shopify: MockServer,
}

async fn world(opts: PgPoolOptions, conn: PgConnectOptions) -> World {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let db = Db::from_pool(app_pool(opts, conn).await);
    let shopify = MockServer::start().await;
    let keys = KeyRing::parse(KEYS).unwrap();
    let auth = ShopifyAuth::new(
        db.clone(),
        keys.clone(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            StdDuration::from_secs(2),
        )
        .unwrap(),
    );
    World {
        auth,
        db,
        owner,
        keys,
        shopify,
    }
}

async fn expect_exchange(w: &World, n: u32, times: u64) {
    Mock::given(method("POST"))
        .and(Field(
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange".to_owned(),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(token_body(n))
                .set_delay(StdDuration::from_millis(100)),
        )
        .expect(times)
        .mount(&w.shopify)
        .await;
}

async fn stored(w: &World, session: &shopify_auth::ShopSession) -> shops::StoredTokens {
    let mut tx = w.db.tenant(session.tenant).await.unwrap();
    shops::get_tokens(&mut tx, session.shop_id)
        .await
        .unwrap()
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_first_session_installs_the_shop_and_seals_its_tokens(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 1).await;

    let session = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap();
    assert!(session.installed);
    assert_eq!(session.shop.as_str(), SHOP);
    assert_eq!(session.user_id.as_deref(), Some("42"));

    let mut tx = w.db.tenant(session.tenant).await.unwrap();
    let shop = shops::get(&mut tx, session.shop_id).await.unwrap().unwrap();
    assert_eq!(shop.status, ShopStatus::Installed);
    assert_eq!(shop.scopes, ["read_products", "read_themes"]);
    assert_eq!(shop.api_version, "2026-10");
    let site = db::repo::sites::get(&mut tx, shop.site_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(site.base_url, "https://demo-store.myshopify.com");
    assert_eq!(site.verification_method.as_deref(), Some("shopify_install"));
    tx.rollback().await.unwrap();

    // Ciphertext only, bound to its slot, with the expiry Shopify reported.
    let row = stored(&w, &session).await;
    for (ct, plain) in [
        (&row.tokens.access_ct, "shpat_access_1"),
        (&row.tokens.refresh_ct, "shprt_refresh_1"),
    ] {
        assert!(!ct.windows(plain.len()).any(|win| win == plain.as_bytes()));
    }
    let access = w
        .keys
        .open_string(
            "k1",
            &row.tokens.access_ct,
            format!("shopify_tokens/access/{}", session.shop_id).as_bytes(),
        )
        .unwrap();
    assert_eq!(access.expose_secret(), "shpat_access_1");
    assert!(
        w.keys
            .open_string(
                "k1",
                &row.tokens.access_ct,
                format!("shopify_tokens/refresh/{}", session.shop_id).as_bytes(),
            )
            .is_err(),
        "an access ciphertext must not open as the refresh slot"
    );
    assert_eq!(row.tokens.access_expires_at, now() + Duration::hours(1));
    assert_eq!(row.tokens.refresh_expires_at, now() + Duration::days(90));

    // One weekly keep-alive job for the shop's tenant, and an audit entry.
    let (queue, run_at, tenant): (String, OffsetDateTime, uuid::Uuid) = sqlx::query_as(
        "select queue, run_at, tenant_id from jobs where queue = 'shopify.token_refresh'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(queue, "shopify.token_refresh");
    assert_eq!(run_at, now() + Duration::days(7));
    assert_eq!(tenant, session.tenant.as_uuid());
    let action: String = sqlx::query_scalar("select action from audit_log")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(action, "shopify.installed");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn later_sessions_reuse_a_valid_token_without_calling_shopify(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 1).await;
    let first = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap();
    let later = now() + Duration::minutes(30);
    let second = w
        .auth
        .authenticate_at(&id_token(SHOP, later), later)
        .await
        .unwrap();
    assert!(!second.installed);
    assert_eq!(
        (second.tenant, second.shop_id),
        (first.tenant, first.shop_id)
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_expired_access_token_is_replaced_by_exchange_during_a_session(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 2).await;
    let first = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap();
    let later = now() + Duration::hours(2);
    let second = w
        .auth
        .authenticate_at(&id_token(SHOP, later), later)
        .await
        .unwrap();
    assert_eq!(second.tenant, first.tenant, "same tenant, no reinstall");
    let row = stored(&w, &second).await;
    assert_eq!(row.version, 1);
    assert_eq!(row.tokens.access_expires_at, later + Duration::hours(1));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn concurrent_first_sessions_install_once_and_exchange_once(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 1).await;
    let token = id_token(SHOP, now());
    let (a, b) = tokio::join!(
        w.auth.authenticate_at(&token, now()),
        w.auth.authenticate_at(&token, now())
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!((a.tenant, a.shop_id), (b.tenant, b.shop_id));
    assert_eq!([a.installed, b.installed].iter().filter(|i| **i).count(), 1);
    let tenants: i64 = sqlx::query_scalar("select count(*) from tenants")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(tenants, 1);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_invalid_session_token_never_reaches_shopify(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 0).await;
    let wrong_secret = encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": "https://x.myshopify.com/admin", "dest": "https://x.myshopify.com",
                "aud": CLIENT_ID, "exp": now().unix_timestamp() + 60, "nbf": 0}),
        &EncodingKey::from_secret(b"wrong"),
    )
    .unwrap();
    let err = w
        .auth
        .authenticate_at(&wrong_secret, now())
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        AuthError::InvalidSessionToken(SessionTokenError::BadSignature)
    ));
    let expired = id_token(SHOP, now() - Duration::minutes(5));
    let err = w.auth.authenticate_at(&expired, now()).await.unwrap_err();
    assert!(matches!(
        err,
        AuthError::InvalidSessionToken(SessionTokenError::Expired)
    ));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_stale_token_in_exchange_asks_for_a_fresh_one_and_stores_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&w.shopify)
        .await;
    let err = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap_err();
    assert!(matches!(err, AuthError::StaleSessionToken), "{err:?}");
    assert!(w.db.shop_by_domain(SHOP).await.unwrap().is_none());
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shopify_outages_are_reported_as_unavailable(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&w.shopify)
        .await;
    let err = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap_err();
    assert!(matches!(err, AuthError::Unavailable(_)), "{err:?}");
    let tenants: i64 = sqlx::query_scalar("select count(*) from tenants")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(tenants, 0);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_uninstalled_shop_is_reinstalled_on_its_next_session(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    expect_exchange(&w, 1, 2).await;
    let first = w
        .auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap();
    sqlx::query("update shopify_shops set status = 'uninstalled', uninstalled_at = now()")
        .execute(&w.owner)
        .await
        .unwrap();
    let later = now() + Duration::minutes(1);
    let again = w
        .auth
        .authenticate_at(&id_token(SHOP, later), later)
        .await
        .unwrap();
    assert!(again.installed);
    assert_eq!(
        again.tenant, first.tenant,
        "the tenant and its history are kept"
    );
    let mut tx = w.db.tenant(again.tenant).await.unwrap();
    let shop = shops::get(&mut tx, again.shop_id).await.unwrap().unwrap();
    assert_eq!(shop.status, ShopStatus::Installed);
    assert!(shop.uninstalled_at.is_none());
}

async fn installed(w: &World) -> shopify_auth::ShopSession {
    expect_exchange(w, 1, 1).await;
    w.auth
        .authenticate_at(&id_token(SHOP, now()), now())
        .await
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_fresh_token_is_not_refreshed(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let s = installed(&w).await;
    let at = now() + Duration::minutes(49);
    assert_eq!(
        w.auth
            .refresh_if_due(s.tenant, s.shop_id, at)
            .await
            .unwrap(),
        RefreshOutcome::Fresh
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_due_token_is_refreshed_with_the_stored_refresh_token_and_rotated(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = installed(&w).await;
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token".to_owned()))
        .and(Field("refresh_token", "shprt_refresh_1".to_owned()))
        .respond_with(ResponseTemplate::new(200).set_body_json(token_body(2)))
        .expect(1)
        .mount(&w.shopify)
        .await;
    let at = now() + Duration::minutes(51);
    assert_eq!(
        w.auth
            .refresh_if_due(s.tenant, s.shop_id, at)
            .await
            .unwrap(),
        RefreshOutcome::Refreshed
    );
    let row = stored(&w, &s).await;
    assert_eq!(row.version, 1);
    assert_eq!(row.tokens.access_expires_at, at + Duration::hours(1));
    let refresh = w
        .keys
        .open_string(
            "k1",
            &row.tokens.refresh_ct,
            format!("shopify_tokens/refresh/{}", s.shop_id).as_bytes(),
        )
        .unwrap();
    assert_eq!(refresh.expose_secret(), "shprt_refresh_2");
    // The new pair is fresh: a second call does nothing.
    assert_eq!(
        w.auth
            .refresh_if_due(s.tenant, s.shop_id, at)
            .await
            .unwrap(),
        RefreshOutcome::Fresh
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_revoked_grant_deletes_the_tokens(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let s = installed(&w).await;
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token".to_owned()))
        .respond_with(ResponseTemplate::new(401))
        .mount(&w.shopify)
        .await;
    let at = now() + Duration::hours(2);
    assert_eq!(
        w.auth
            .refresh_if_due(s.tenant, s.shop_id, at)
            .await
            .unwrap(),
        RefreshOutcome::Revoked
    );
    let mut tx = w.db.tenant(s.tenant).await.unwrap();
    assert!(
        shops::get_tokens(&mut tx, s.shop_id)
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        w.auth
            .refresh_if_due(s.tenant, s.shop_id, at)
            .await
            .unwrap(),
        RefreshOutcome::NotInstalled
    );
    assert!(
        w.auth
            .access_token(s.tenant, s.shop_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_failed_refresh_keeps_the_stored_pair(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let s = installed(&w).await;
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token".to_owned()))
        .respond_with(ResponseTemplate::new(502))
        .mount(&w.shopify)
        .await;
    let at = now() + Duration::hours(2);
    let err = w
        .auth
        .refresh_if_due(s.tenant, s.shop_id, at)
        .await
        .unwrap_err();
    assert!(matches!(err, RefreshError::Retryable(_)), "{err:?}");
    assert_eq!(stored(&w, &s).await.version, 0);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn refresh_from_another_tenant_finds_nothing(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let s = installed(&w).await;
    let stranger = domain::TenantId::new();
    let mut tx = w.db.tenant(stranger).await.unwrap();
    db::repo::tenants::create(&mut tx, domain::TenantKind::Organization)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        w.auth
            .refresh_if_due(stranger, s.shop_id, now() + Duration::hours(2))
            .await
            .unwrap(),
        RefreshOutcome::NotInstalled
    );
}

#[test]
fn keepalive_jobs_deduplicate_per_iso_week() {
    let shop = domain::ShopId::new();
    let monday = OffsetDateTime::from_unix_timestamp(1_792_368_000).unwrap(); // 2026-10-19
    let a = shopify_auth::keepalive_job(shop, monday);
    let b = shopify_auth::keepalive_job(shop, monday + Duration::days(3));
    let c = shopify_auth::keepalive_job(shop, monday + Duration::days(7));
    assert_eq!(a.idempotency_key, b.idempotency_key);
    assert_ne!(a.idempotency_key, c.idempotency_key);
    assert_eq!(a.queue, "shopify.token_refresh");
    assert_eq!(a.payload_schema, "shopify.token_refresh@1");
    assert_eq!(a.payload, json!({"shop_id": shop.as_uuid().to_string()}));
}
