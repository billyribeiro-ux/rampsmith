//! The embedded app's routes (ADR-083): each operation against a real database, signed in the
//! way Shopify signs a session, with the data another shop owns beside it.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_arguments
)]

use std::time::Duration;

use api::AppState;
use api::plan::PartnerPlans;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use billing::partner_api::PartnerCredentials;
use crypto::KeyRing;
use db::Db;
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
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod support;

use support::app_login_pool;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_api_test";
const SHOP: &str = "demo-store.myshopify.com";
const STAFF: &str = "42";
const ORIGIN: &str = "https://app.rampsmith.test";
const PRODUCT: &str = "gid://shopify/Product/100";
const IMAGE: &str = "gid://shopify/MediaImage/200";
const KEYS: &str = "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

struct Harness {
    state: AppState,
    owner: PgPool,
    tenant: Uuid,
    site: Uuid,
    shop: Uuid,
    _shopify: MockServer,
}

struct Answer {
    status: StatusCode,
    content_type: String,
    headers: header::HeaderMap,
    bytes: Vec<u8>,
    body: Value,
}

fn id_token(domain: &str, sub: &str) -> String {
    id_token_for(domain, Some(sub))
}

/// An ID token; `sub` is absent for a session that is not a signed-in staff member.
fn id_token_for(domain: &str, sub: Option<&str>) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let mut claims = json!({
        "iss": format!("https://{domain}/admin"),
        "dest": format!("https://{domain}"),
        "aud": CLIENT_ID,
        "exp": now + 60,
        "nbf": now - 1,
        "iat": now - 1,
        "jti": "j",
        "sid": "s"
    });
    if let Some(sub) = sub {
        claims["sub"] = json!(sub);
    }
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

/// Installs the shop through a first session, then returns what is needed to seed and call.
async fn harness(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
    keys: bool,
    partner: Option<PartnerPlans>,
) -> Harness {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "shpat_a",
            "scope": "read_products,write_products",
            "expires_in": 3600,
            "refresh_token": "shprt_r",
            "refresh_token_expires_in": 7_776_000
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
    let identity =
        identity::Identity::new(db.clone(), "app.rampsmith.test", ORIGIN, "Rampsmith").unwrap();
    let mut state = AppState::new(db).with_shopify(auth).with_identity(identity);
    if keys {
        state = state.with_keys(KeyRing::parse(KEYS).unwrap());
    }
    if let Some(partner) = partner {
        state = state.with_partner(partner);
    }
    let installed = api::app(state.clone())
        .oneshot(
            Request::post("/v1/shopify/session")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", id_token(SHOP, STAFF)),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(installed.status(), StatusCode::OK);
    let (tenant, site, shop): (Uuid, Uuid, Uuid) =
        sqlx::query_as("select tenant_id, site_id, id from shopify_shops where shop_domain = $1")
            .bind(SHOP)
            .fetch_one(&owner)
            .await
            .unwrap();
    Harness {
        state,
        owner,
        tenant,
        site,
        shop,
        _shopify: shopify,
    }
}

impl Harness {
    async fn call(&self, verb: &str, uri: &str, body: Option<Value>) -> Answer {
        self.call_as(Some(STAFF), verb, uri, body).await
    }

    /// Like `call`, with the session of `sub`, or one with no staff member at all.
    async fn call_as(
        &self,
        sub: Option<&str>,
        verb: &str,
        uri: &str,
        body: Option<Value>,
    ) -> Answer {
        self.call_for(SHOP, sub, verb, uri, body).await
    }

    /// Like `call_as`, signed for another shop's domain.
    async fn call_for(
        &self,
        domain: &str,
        sub: Option<&str>,
        verb: &str,
        uri: &str,
        body: Option<Value>,
    ) -> Answer {
        let mut request = Request::builder().method(verb).uri(uri).header(
            header::AUTHORIZATION,
            format!("Bearer {}", id_token_for(domain, sub)),
        );
        let body = match body {
            Some(value) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let res = api::app(self.state.clone())
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Answer {
            status,
            content_type,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            bytes,
        }
    }

    async fn get(&self, uri: &str) -> Answer {
        self.call("GET", uri, None).await
    }

    async fn scan(
        &self,
        status: &str,
        trigger: &str,
        minutes_ago: i32,
        coverage: Option<Value>,
    ) -> Uuid {
        sqlx::query_scalar(
            "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, coverage,
                                pages_planned, pages_done, checks_run, checks_passed, created_at)
             values (gen_random_uuid(), $1, $2, $3, $4, 'axe-core 4.11.1; a11y-rules 0a1b2c3d', $5, 6, 6, 120, 100,
                     now() - make_interval(mins => $6))
             returning id",
        )
        .bind(self.tenant)
        .bind(self.site)
        .bind(trigger)
        .bind(status)
        .bind(coverage)
        .bind(minutes_ago)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    async fn finding(
        &self,
        scan: Uuid,
        rule: &str,
        impact: &str,
        status: &str,
        origin: &str,
        score: Option<f64>,
        best_practice: bool,
        criteria: &[&str],
    ) -> Uuid {
        let criteria: Vec<String> = criteria.iter().map(|c| (*c).to_owned()).collect();
        sqlx::query_scalar(
            "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact,
                                   status, source_location, first_seen_scan, last_seen_scan,
                                   occurrence_count, origin, priority_score, templates_affected,
                                   best_practice)
             values (gen_random_uuid(), $1, $2,
                     decode(md5(random()::text) || md5(random()::text), 'hex'), $3, $4, $5, $6,
                     jsonb_build_object('resource', $7::text, 'owner', $8::text), $9, $9, 2, $10,
                     $11, 1, $12)
             returning id",
        )
        .bind(self.tenant)
        .bind(self.site)
        .bind(rule)
        .bind(criteria)
        .bind(impact)
        .bind(status)
        .bind(IMAGE)
        .bind(PRODUCT)
        .bind(scan)
        .bind(origin)
        .bind(score)
        .bind(best_practice)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    async fn occurrence(&self, finding: Uuid, scan: Uuid, page_type: &str, target: &str) {
        sqlx::query(
            "insert into finding_occurrences (finding_id, scan_id, tenant_id, page_url,
                                              page_state, target, html_excerpt, captured_at,
                                              page_type, viewport)
             values ($1, $2, $3, 'https://demo-store.myshopify.com/products/shoe', 'default',
                     $4, '<img src=\"x.png\">', now(), $5, 'desktop')",
        )
        .bind(finding)
        .bind(scan)
        .bind(self.tenant)
        .bind(target)
        .bind(page_type)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    async fn products(&self, scan: Uuid) {
        sqlx::query(
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
             values (gen_random_uuid(), $1, $2, $3, 'products', 0, $4)",
        )
        .bind(self.tenant)
        .bind(scan)
        .bind(self.site)
        .bind(json!({"items": [{
            "id": PRODUCT, "title": "Blue Shoe",
            "media": [{"id": IMAGE, "url": "https://cdn.shopify.com/s/files/shoe.png"}]
        }]}))
        .execute(&self.owner)
        .await
        .unwrap();
    }

    /// A data fix for `finding`, with its snapshot.
    async fn fix(&self, finding: Uuid, status: &str, after: &str, ai: bool) -> Uuid {
        let approved = !matches!(status, "proposed" | "rejected");
        let id: Uuid = sqlx::query_scalar(
            "insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model,
                                prompt_version, confidence, diff, approved_at, approved_by_ref,
                                applied_at)
             values (gen_random_uuid(), $1, $2, 'data', 'admin_api', $3, $4, $5, $6, $7, $8,
                     case when $9 then now() end, case when $9 then 'staff-1' end,
                     case when $3 in ('applied', 'verified') then now() end)
             returning id",
        )
        .bind(self.tenant)
        .bind(self.site)
        .bind(status)
        .bind(if ai { "ai" } else { "rule" })
        .bind(ai.then_some("claude-haiku-5-5"))
        .bind(ai.then_some("v1"))
        .bind(ai.then_some(0.91_f64))
        .bind(json!({
            "type": "alt_text", "resource_gid": IMAGE, "field": "alt", "before": null,
            "after": after, "language": "en", "contains_text": false, "escalated": false
        }))
        .bind(approved)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        sqlx::query("insert into fix_findings (fix_id, finding_id, tenant_id) values ($1, $2, $3)")
            .bind(id)
            .bind(finding)
            .bind(self.tenant)
            .execute(&self.owner)
            .await
            .unwrap();
        sqlx::query(
            "insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value,
                                             after_value)
             values ($1, $2, $3, 'alt', 'null', to_jsonb($4::text))",
        )
        .bind(id)
        .bind(self.tenant)
        .bind(IMAGE)
        .bind(after)
        .execute(&self.owner)
        .await
        .unwrap();
        id
    }

    async fn count(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.tenant)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

/// A second shop's rows in the same database, to prove none of them leaks.
async fn other_shop(h: &Harness) -> (Uuid, Uuid, Uuid) {
    let tenant: Uuid = sqlx::query_scalar(
        "insert into tenants (id, kind) values (gen_random_uuid(), 'shopify_store') returning id",
    )
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let site: Uuid = sqlx::query_scalar(
        "insert into sites (id, tenant_id, platform, base_url)
         values (gen_random_uuid(), $1, 'shopify', 'https://other.myshopify.com') returning id",
    )
    .bind(tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let scan: Uuid = sqlx::query_scalar(
        "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version)
         values (gen_random_uuid(), $1, $2, 'manual', 'succeeded', 'axe-core 4') returning id",
    )
    .bind(tenant)
    .bind(site)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let finding: Uuid = sqlx::query_scalar(
        "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact,
                               status, first_seen_scan, last_seen_scan, occurrence_count)
         values (gen_random_uuid(), $1, $2, decode(repeat('cd', 32), 'hex'), 'rs-media-alt-empty',
                 '{1.1.1}', 'critical', 'open', $3, $3, 1) returning id",
    )
    .bind(tenant)
    .bind(site)
    .bind(scan)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let fix: Uuid = sqlx::query_scalar(
        "insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, diff)
         values (gen_random_uuid(), $1, $2, 'data', 'admin_api', 'proposed', 'rule',
                 '{\"resource_gid\": \"gid://shopify/MediaImage/9\", \"field\": \"alt\", \"after\": \"Other\"}')
         returning id",
    )
    .bind(tenant)
    .bind(site)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    (scan, finding, fix)
}

fn plain(opts: PgPoolOptions, conn: PgConnectOptions) -> impl Future<Output = Harness> {
    harness(opts, conn, false, None)
}

// --- Overview ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn the_overview_counts_open_findings_and_fixes_without_best_practices(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let empty = h.get("/v1/shopify/overview").await;
    assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
    assert_eq!(empty.body["shop"]["domain"], SHOP);
    assert_eq!(
        empty.body["shop"]["name"],
        Value::Null,
        "no name before the first read"
    );
    assert_eq!(empty.body["latest_scan"], Value::Null);
    assert_eq!(empty.body["entitlements"]["plan"], "free");
    assert_eq!(empty.body["entitlements"]["alt_text_drafts"]["limit"], 25);
    assert_eq!(empty.body["entitlements"]["alt_text_drafts"]["used"], 0);
    sqlx::query("update shopify_shops set name = 'Super Toys' where tenant_id = $1")
        .bind(h.tenant)
        .execute(&h.owner)
        .await
        .unwrap();
    let named = h.get("/v1/shopify/overview").await;
    assert_eq!(named.body["shop"]["name"], "Super Toys");

    let scan = h
        .scan(
            "succeeded",
            "manual",
            5,
            Some(
                json!({"criteria_tested": ["1.1.1", "2.4.4"], "review_queue": 3,
                        "ruleset": {"axe": "4.11.1"}}),
            ),
        )
        .await;
    h.scan("succeeded", "verify", 1, None).await;
    let critical = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    h.finding(
        scan,
        "image-alt",
        "serious",
        "open",
        "render",
        Some(40.0),
        false,
        &["1.1.1"],
    )
    .await;
    h.finding(
        scan,
        "heading-order",
        "moderate",
        "open",
        "render",
        None,
        true,
        &["1.3.1"],
    )
    .await;
    h.finding(
        scan,
        "label",
        "serious",
        "fixed",
        "render",
        None,
        false,
        &["1.3.1"],
    )
    .await;
    h.fix(critical, "proposed", "A blue shoe", true).await;
    h.fix(critical, "applied", "A blue shoe, side view", false)
        .await;
    let (other_scan, _, _) = other_shop(&h).await;
    assert_ne!(other_scan, scan);

    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(overview.status, StatusCode::OK, "{}", overview.body);
    assert_eq!(
        overview.body["open_by_impact"],
        json!({"minor": 0, "moderate": 0, "serious": 1, "critical": 1})
    );
    assert_eq!(overview.body["fixes_awaiting_approval"], 1);
    assert_eq!(overview.body["fixes_applied"], 1);
    assert!(overview.body["first_fix_at"].is_string());
    let latest = &overview.body["latest_scan"];
    assert_eq!(
        latest["id"],
        scan.to_string(),
        "a verification scan is not the latest scan"
    );
    assert_eq!(latest["coverage"]["automated"], json!(["1.1.1", "2.4.4"]));
    assert_eq!(latest["coverage"]["review_queue"], 3);
    assert_eq!(
        latest["ruleset_version"], "axe-core 4.11.1; a11y-rules 0a1b2c3d",
        "the version the engine recorded is served as it is"
    );
    assert_eq!(overview.body["next_scan_at"], Value::Null);
    let features = overview.body["entitlements"]["features"]
        .as_array()
        .unwrap();
    let github = features
        .iter()
        .find(|f| f["feature"] == "github_pull_requests")
        .unwrap();
    assert_eq!(github["gate"], "locked");
    assert_eq!(github["unlocked_by"], "starter");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn every_operation_needs_a_session(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    for (verb, uri) in [
        ("GET", "/v1/shopify/overview"),
        ("POST", "/v1/shopify/scans"),
        ("GET", "/v1/shopify/findings"),
        ("GET", "/v1/shopify/fixes"),
        ("GET", "/v1/shopify/settings"),
        ("PUT", "/v1/shopify/settings"),
        ("GET", "/v1/shopify/statement"),
        ("PUT", "/v1/shopify/statement"),
    ] {
        let res = api::app(h.state.clone())
            .oneshot(
                Request::builder()
                    .method(verb)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{verb} {uri}");
    }
}

// --- Scans ------------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn starting_a_scan_queues_the_read_and_refuses_a_second_while_one_runs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let first = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(first.status, StatusCode::ACCEPTED, "{}", first.body);
    assert_eq!(first.body["scan"]["status"], "queued");
    assert_eq!(first.body["scan"]["trigger"], "manual");
    let scan_id = first.body["scan"]["id"].as_str().unwrap().to_owned();

    let (queue, payload): (String, Value) = sqlx::query_as(
        "select queue, payload from jobs where tenant_id = $1 and queue = 'shopify.read_store'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(queue, "shopify.read_store");
    assert_eq!(payload["scan_id"], scan_id);
    assert_eq!(payload["shop_id"], h.shop.to_string());
    assert_eq!(
        h.count("select count(*) from audit_log where tenant_id = $1 and action = 'scan.started'")
            .await,
        1
    );

    let second = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(second.status, StatusCode::CONFLICT);
    assert_eq!(second.body["code"], "conflict");
    assert_eq!(
        h.count("select count(*) from jobs where tenant_id = $1 and queue = 'shopify.read_store'")
            .await,
        1
    );

    let read = h.get(&format!("/v1/shopify/scans/{scan_id}")).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.body["id"], scan_id);
    assert_eq!(read.body["coverage"], Value::Null);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn manual_scans_are_limited_per_plan_per_day_and_need_a_chosen_plan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    // Free allows two scans started by hand in 24 hours; scheduled ones do not count.
    h.scan("succeeded", "scheduled", 5, None).await;
    h.scan("succeeded", "manual", 60, None).await;
    let second = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(second.status, StatusCode::ACCEPTED, "{}", second.body);
    sqlx::query("update scans set status = 'succeeded' where tenant_id = $1")
        .bind(h.tenant)
        .execute(&h.owner)
        .await
        .unwrap();
    let third = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(
        third.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        third.body
    );
    assert_eq!(third.body["code"], "rate_limited");
    assert!(
        third.body["detail"]
            .as_str()
            .unwrap()
            .contains("free plan allows 2"),
        "{}",
        third.body
    );

    // A scan from 25 hours ago is out of the window; a paid plan has more.
    sqlx::query(
        "update scans set created_at = created_at - interval '25 hours' where trigger = 'manual'",
    )
    .execute(&h.owner)
    .await
    .unwrap();
    let after = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(after.status, StatusCode::ACCEPTED, "{}", after.body);

    // A shop Shopify says has no plan yet is told to choose one.
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing) values ($1, $2, 'no_active_plan')",
    )
    .bind(h.shop)
    .bind(h.tenant)
    .execute(&h.owner)
    .await
    .unwrap();
    let none = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(none.status, StatusCode::FORBIDDEN, "{}", none.body);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_paid_plan_allows_more_manual_scans(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval,
                                   last_confirmed_at)
         values ($1, $2, 'paid', 'starter', 'monthly', now())",
    )
    .bind(h.shop)
    .bind(h.tenant)
    .execute(&h.owner)
    .await
    .unwrap();
    for _ in 0..5 {
        h.scan("succeeded", "manual", 10, None).await;
    }
    let sixth = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(sixth.status, StatusCode::ACCEPTED, "{}", sixth.body);
    sqlx::query("update scans set status = 'succeeded' where tenant_id = $1")
        .bind(h.tenant)
        .execute(&h.owner)
        .await
        .unwrap();
    let seventh = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(seventh.status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn twenty_concurrent_scan_starts_create_one_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let h = std::sync::Arc::new(h);
    let mut calls = Vec::new();
    for _ in 0..20 {
        let h = std::sync::Arc::clone(&h);
        calls.push(tokio::spawn(async move {
            h.call("POST", "/v1/shopify/scans", None).await.status
        }));
    }
    let mut accepted = 0;
    for call in calls {
        match call.await.unwrap() {
            StatusCode::ACCEPTED => accepted += 1,
            StatusCode::CONFLICT => {}
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!(accepted, 1);
    assert_eq!(
        h.count("select count(*) from scans where tenant_id = $1")
            .await,
        1
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_stale_running_scan_does_not_block_a_new_one(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    h.scan("running", "manual", 180, None).await;
    let started = h.call("POST", "/v1/shopify/scans", None).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_scan_of_another_shop_or_a_bad_id_is_not_found(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let (other, _, _) = other_shop(&h).await;
    for id in [
        other.to_string(),
        "not-a-uuid".to_owned(),
        Uuid::new_v4().to_string(),
    ] {
        let res = h.get(&format!("/v1/shopify/scans/{id}")).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(res.content_type, "application/problem+json");
    }
}

// --- Findings ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn findings_list_in_priority_order_with_filters_and_a_cursor(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let top = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let mid = h
        .finding(
            scan,
            "image-alt",
            "serious",
            "open",
            "render",
            Some(40.0),
            false,
            &["1.1.1", "4.1.2"],
        )
        .await;
    let low = h
        .finding(
            scan,
            "rs-rich-text-link-vague",
            "moderate",
            "needs_review",
            "data",
            None,
            false,
            &["2.4.4"],
        )
        .await;
    h.fix(top, "proposed", "A blue shoe", true).await;
    other_shop(&h).await;

    let all = h.get("/v1/shopify/findings").await;
    assert_eq!(all.status, StatusCode::OK, "{}", all.body);
    let ids: Vec<&str> = all.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [top.to_string(), mid.to_string(), low.to_string()]);
    assert_eq!(all.body["total"], 3);
    assert_eq!(all.body["next_cursor"], Value::Null);
    let first = &all.body["items"][0];
    assert_eq!(
        first["title"],
        "A product image has no alt text, so screen-reader users miss what it shows."
    );
    assert_eq!(first["fix"]["status"], "proposed");
    assert_eq!(first["priority_score"], 90.0);
    assert_eq!(all.body["items"][2]["priority_score"], Value::Null);

    for (query, expected) in [
        ("impact=serious", vec![mid]),
        ("status=needs_review", vec![low]),
        ("origin=data", vec![top, low]),
        ("criterion=4.1.2", vec![mid]),
        ("has_fix=true", vec![top]),
        ("has_fix=false", vec![mid, low]),
    ] {
        let res = h.get(&format!("/v1/shopify/findings?{query}")).await;
        let got: Vec<String> = res.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_owned())
            .collect();
        let want: Vec<String> = expected.iter().map(Uuid::to_string).collect();
        assert_eq!(got, want, "{query}");
    }

    let page = h.get("/v1/shopify/findings?limit=2").await;
    assert_eq!(page.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(page.body["total"], 3);
    let cursor = page.body["next_cursor"].as_str().unwrap();
    let rest = h
        .get(&format!("/v1/shopify/findings?limit=2&cursor={cursor}"))
        .await;
    assert_eq!(rest.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(rest.body["next_cursor"], Value::Null);

    for bad in [
        "impact=huge",
        "status=odd",
        "origin=x",
        "cursor=abc",
        "limit=0",
        "limit=500",
    ] {
        let res = h.get(&format!("/v1/shopify/findings?{bad}")).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(res.body["code"], "validation_failed");
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_finding_shows_its_explanation_occurrences_templates_and_fixes(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    h.products(scan).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    h.occurrence(finding, scan, "product", "img.hero").await;
    h.occurrence(finding, scan, "product", "img.thumb").await;
    h.occurrence(finding, scan, "collection", "img.card").await;
    let fix = h.fix(finding, "proposed", "A blue shoe", true).await;
    let evidence: Uuid = sqlx::query_scalar(
        "insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes)
         values (gen_random_uuid(), $1, $2, $3, 'image/png', '\\x89504e47') returning id",
    )
    .bind(h.tenant)
    .bind(scan)
    .bind(finding)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    sqlx::query("update fixes set before_evidence_id = $1 where id = $2")
        .bind(evidence)
        .bind(fix)
        .execute(&h.owner)
        .await
        .unwrap();
    let (_, other_finding, _) = other_shop(&h).await;

    let res = h.get(&format!("/v1/shopify/findings/{finding}")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["rule_id"], "rs-media-alt-empty");
    assert!(
        res.body["explanation"]
            .as_str()
            .unwrap()
            .contains("no alt text")
    );
    assert_eq!(res.body["occurrences"].as_array().unwrap().len(), 3);
    assert_eq!(res.body["templates"], json!(["collection", "product"]));
    assert_eq!(
        res.body["evidence"],
        json!([{"id": evidence.to_string(), "kind": "before"}])
    );
    let card = &res.body["fixes"][0];
    assert_eq!(card["id"], fix.to_string());
    assert_eq!(card["status"], "proposed");
    assert_eq!(card["origin"], "ai");
    assert_eq!(card["model"], "claude-haiku-5-5");
    assert_eq!(card["change"]["after"], "A blue shoe");
    assert_eq!(card["change"]["before"], Value::Null);
    assert_eq!(card["change"]["type"], "alt_text");
    assert_eq!(card["product_title"], "Blue Shoe");
    assert_eq!(
        card["image_url"],
        "https://cdn.shopify.com/s/files/shoe.png"
    );
    assert_eq!(card["findings"][0]["rule_id"], "rs-media-alt-empty");
    assert_eq!(card["approver_name"], Value::Null);

    for id in [other_finding.to_string(), "nope".to_owned()] {
        let res = h.get(&format!("/v1/shopify/findings/{id}")).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND);
    }
}

// --- Fixes ------------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn fixes_list_by_state(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let proposed = h.fix(finding, "proposed", "One", true).await;
    let failed = h.fix(finding, "failed", "Two", true).await;
    let applied = h.fix(finding, "applied", "Three", false).await;
    let reverted = h.fix(finding, "reverted", "Four", false).await;
    other_shop(&h).await;
    let ids = |res: &Answer| -> Vec<String> {
        res.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let queue = h.get("/v1/shopify/fixes").await;
    let mut got = ids(&queue);
    got.sort();
    let mut want = vec![proposed.to_string(), failed.to_string()];
    want.sort();
    assert_eq!(got, want);
    assert_eq!(
        ids(&h.get("/v1/shopify/fixes?state=applied").await),
        [applied.to_string()]
    );
    let all = h.get("/v1/shopify/fixes?state=all").await;
    assert_eq!(ids(&all).len(), 4);
    assert!(ids(&all).contains(&reverted.to_string()));
    let paged = h.get("/v1/shopify/fixes?state=all&limit=3").await;
    assert_eq!(ids(&paged).len(), 3);
    assert_eq!(paged.body["next_cursor"], "3");
    assert_eq!(
        h.get("/v1/shopify/fixes?state=bogus").await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn editing_a_waiting_fix_changes_its_diff_and_snapshot(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let fix = h.fix(finding, "proposed", "A blue shoe", true).await;
    let (_, _, other_fix) = other_shop(&h).await;

    let edited = h
        .call(
            "PUT",
            &format!("/v1/shopify/fixes/{fix}"),
            Some(json!({"alt": "  A blue running shoe  "})),
        )
        .await;
    assert_eq!(edited.status, StatusCode::OK, "{}", edited.body);
    assert_eq!(edited.body["edited"], true);
    assert_eq!(edited.body["change"]["after"], "A blue running shoe");
    let snapshot: Value =
        sqlx::query_scalar("select after_value from data_fix_snapshots where fix_id = $1")
            .bind(fix)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!(
        snapshot,
        json!("A blue running shoe"),
        "what is applied is what was reviewed"
    );

    for body in [
        json!({"alt": "   "}),
        json!({"alt": "x".repeat(151)}),
        json!({"alt": 5}),
        json!({"alt": "ok", "extra": 1}),
    ] {
        let res = h
            .call(
                "PUT",
                &format!("/v1/shopify/fixes/{fix}"),
                Some(body.clone()),
            )
            .await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    let too_long = h
        .call(
            "PUT",
            &format!("/v1/shopify/fixes/{fix}"),
            Some(json!({"alt": "x".repeat(151)})),
        )
        .await;
    assert_eq!(too_long.body["errors"][0]["field"], "alt");

    let foreign = h
        .call(
            "PUT",
            &format!("/v1/shopify/fixes/{other_fix}"),
            Some(json!({"alt": "Hijack"})),
        )
        .await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);
    let untouched: Value = sqlx::query_scalar("select diff -> 'after' from fixes where id = $1")
        .bind(other_fix)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(untouched, json!("Other"));

    h.call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
        .await;
    let late = h
        .call(
            "PUT",
            &format!("/v1/shopify/fixes/{fix}"),
            Some(json!({"alt": "Too late"})),
        )
        .await;
    assert_eq!(late.status, StatusCode::CONFLICT);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn approving_records_the_staff_member_and_queues_the_apply_in_the_same_step(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let fix = h.fix(finding, "proposed", "A blue shoe", true).await;

    let approved = h
        .call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
        .await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.body);
    assert_eq!(approved.body["status"], "approved");
    assert!(approved.body["approved_at"].is_string());
    let (by_ref, by_user): (Option<String>, Option<Uuid>) =
        sqlx::query_as("select approved_by_ref, approved_by from fixes where id = $1")
            .bind(fix)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!(
        by_ref.as_deref(),
        Some(format!("shopify:{STAFF}").as_str()),
        "one actor format: shopify:<sub>"
    );
    assert!(by_user.is_none());
    let (queue, payload): (String, Value) = sqlx::query_as(
        "select queue, payload from jobs where tenant_id = $1 and queue = 'shopify.apply_data_fix'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(queue, "shopify.apply_data_fix");
    assert_eq!(payload["fix_id"], fix.to_string());
    assert_eq!(payload["shop_id"], h.shop.to_string());
    let audit: (String, Option<String>) = sqlx::query_as(
        "select actor_kind, actor_id from audit_log where tenant_id = $1 and action = 'fix.approved'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(audit, ("user".to_owned(), Some(format!("shopify:{STAFF}"))));

    let again = h
        .call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(
        h.count(
            "select count(*) from jobs where tenant_id = $1 and queue = 'shopify.apply_data_fix'"
        )
        .await,
        1,
        "a second approval queues nothing"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn free_covers_the_first_twenty_five_images_and_no_more(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    for n in 0..25 {
        h.fix(finding, "applied", &format!("Done {n}"), false).await;
    }
    let waiting = h.fix(finding, "proposed", "One too many", true).await;
    let refused = h
        .call(
            "POST",
            &format!("/v1/shopify/fixes/{waiting}/approve"),
            None,
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(refused.body["code"], "forbidden");
    let status: String = sqlx::query_scalar("select status from fixes where id = $1")
        .bind(waiting)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(status, "proposed");
    assert_eq!(
        h.count(
            "select count(*) from jobs where tenant_id = $1 and queue = 'shopify.apply_data_fix'"
        )
        .await,
        0
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_scan_the_engine_has_not_stamped_falls_back_to_the_coverage_documents_axe_version(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h
        .scan(
            "succeeded",
            "manual",
            5,
            Some(json!({"ruleset": {"axe": "4.11.1"}})),
        )
        .await;
    sqlx::query("update scans set ruleset_version = 'axe-core' where id = $1")
        .bind(scan)
        .execute(&h.owner)
        .await
        .unwrap();
    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(
        overview.body["latest_scan"]["ruleset_version"],
        "axe-core 4.11.1"
    );
    sqlx::query("update scans set coverage = null where id = $1")
        .bind(scan)
        .execute(&h.owner)
        .await
        .unwrap();
    let bare = h.get("/v1/shopify/overview").await;
    assert_eq!(bare.body["latest_scan"]["ruleset_version"], "axe-core");
}

/// A shop at 24 of its 25 free image fixes, with `proposed` more fixes waiting for approval.
async fn one_image_left(h: &Harness, proposed: usize) -> Vec<Uuid> {
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    for n in 0..24 {
        h.fix(finding, "applied", &format!("Done {n}"), false).await;
    }
    let mut waiting = Vec::new();
    for n in 0..proposed {
        waiting.push(
            h.fix(finding, "proposed", &format!("Waiting {n}"), true)
                .await,
        );
    }
    waiting
}

async fn apply_jobs(h: &Harness) -> i64 {
    h.count("select count(*) from jobs where tenant_id = $1 and queue = 'shopify.apply_data_fix'")
        .await
}

#[sqlx::test(migrations = "../db/migrations")]
async fn twenty_approvals_at_once_pass_the_last_image_of_the_allowance_exactly_once(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = std::sync::Arc::new(plain(opts, conn).await);
    let waiting = one_image_left(&h, 20).await;
    let mut calls = Vec::new();
    for fix in waiting {
        let h = std::sync::Arc::clone(&h);
        calls.push(tokio::spawn(async move {
            h.call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
                .await
                .status
        }));
    }
    let mut ok = 0;
    let mut forbidden = 0;
    for call in calls {
        match call.await.unwrap() {
            StatusCode::OK => ok += 1,
            StatusCode::FORBIDDEN => forbidden += 1,
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!((ok, forbidden), (1, 19), "exactly one approval fits");
    assert_eq!(apply_jobs(&h).await, 1);
}

/// The lock is what makes the count above reliable, so this test pins the lock itself: while
/// another transaction holds the site row, an approval waits; when it lets go, the approval
/// goes through. A version of `approve_fix` that forgot `lock_site` would answer at once.
#[sqlx::test(migrations = "../db/migrations")]
async fn an_approval_waits_for_the_site_lock(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = std::sync::Arc::new(plain(opts, conn).await);
    let waiting = one_image_left(&h, 1).await;
    let mut holder = h.owner.begin().await.unwrap();
    sqlx::query("select id from sites where id = $1 for update")
        .bind(h.site)
        .fetch_one(&mut *holder)
        .await
        .unwrap();

    let fix = waiting[0];
    let approving = {
        let h = std::sync::Arc::clone(&h);
        tokio::spawn(async move {
            h.call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
                .await
                .status
        })
    };
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !approving.is_finished(),
        "the approval did not wait for the site lock"
    );
    assert_eq!(apply_jobs(&h).await, 0);

    holder.rollback().await.unwrap();
    assert_eq!(approving.await.unwrap(), StatusCode::OK);
    assert_eq!(apply_jobs(&h).await, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn rejecting_decides_a_waiting_fix_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let fix = h.fix(finding, "proposed", "A blue shoe", true).await;
    let (_, _, other_fix) = other_shop(&h).await;

    let rejected = h
        .call("POST", &format!("/v1/shopify/fixes/{fix}/reject"), None)
        .await;
    assert_eq!(rejected.status, StatusCode::OK, "{}", rejected.body);
    assert_eq!(rejected.body["status"], "rejected");
    assert_eq!(
        h.call("POST", &format!("/v1/shopify/fixes/{fix}/reject"), None)
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.call("POST", &format!("/v1/shopify/fixes/{fix}/approve"), None)
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.call(
            "POST",
            &format!("/v1/shopify/fixes/{other_fix}/reject"),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let other_status: String = sqlx::query_scalar("select status from fixes where id = $1")
        .bind(other_fix)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(other_status, "proposed");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn undo_queues_one_revert_for_an_applied_fix(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let applied = h.fix(finding, "applied", "A blue shoe", true).await;
    let waiting = h.fix(finding, "proposed", "Not yet", true).await;

    // A session with no staff member cannot undo (audit L10): nothing is queued.
    let anonymous = h
        .call_as(
            None,
            "POST",
            &format!("/v1/shopify/fixes/{applied}/undo"),
            None,
        )
        .await;
    assert_eq!(
        anonymous.status,
        StatusCode::FORBIDDEN,
        "{}",
        anonymous.body
    );
    assert_eq!(
        h.count(
            "select count(*) from jobs where tenant_id = $1 and queue = 'shopify.revert_data_fix'"
        )
        .await,
        0
    );

    let queued = h
        .call("POST", &format!("/v1/shopify/fixes/{applied}/undo"), None)
        .await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{}", queued.body);
    assert_eq!(
        queued.body["status"], "applied",
        "the job reverts it, not this request"
    );
    let payload: Value = sqlx::query_scalar(
        "select payload from jobs where tenant_id = $1 and queue = 'shopify.revert_data_fix'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(payload["fix_id"], applied.to_string());

    let again = h
        .call("POST", &format!("/v1/shopify/fixes/{applied}/undo"), None)
        .await;
    assert_eq!(
        again.status,
        StatusCode::CONFLICT,
        "an undo is already running"
    );
    assert_eq!(
        h.call("POST", &format!("/v1/shopify/fixes/{waiting}/undo"), None)
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.count(
            "select count(*) from jobs where tenant_id = $1 and queue = 'shopify.revert_data_fix'"
        )
        .await,
        1
    );
}

// --- Evidence ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn evidence_is_served_as_inert_bytes_to_its_own_shop_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let evidence: Uuid = sqlx::query_scalar(
        "insert into evidence (id, tenant_id, scan_id, content_type, bytes)
         values (gen_random_uuid(), $1, $2, 'image/png', '\\x89504e470d0a') returning id",
    )
    .bind(h.tenant)
    .bind(scan)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let (other_scan, _, _) = other_shop(&h).await;
    let other_tenant: Uuid = sqlx::query_scalar("select tenant_id from scans where id = $1")
        .bind(other_scan)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let foreign: Uuid = sqlx::query_scalar(
        "insert into evidence (id, tenant_id, scan_id, content_type, bytes)
         values (gen_random_uuid(), $1, $2, 'image/png', '\\x89504e47') returning id",
    )
    .bind(other_tenant)
    .bind(other_scan)
    .fetch_one(&h.owner)
    .await
    .unwrap();

    let res = h.get(&format!("/v1/shopify/evidence/{evidence}")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.content_type, "image/png");
    assert_eq!(res.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert_eq!(res.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(res.headers[header::CACHE_CONTROL], "private, no-store");
    assert!(
        res.headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert_eq!(
        h.get(&format!("/v1/shopify/evidence/{foreign}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.get("/v1/shopify/evidence/xyz").await.status,
        StatusCode::NOT_FOUND
    );
}

// --- Settings ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn settings_have_defaults_and_validate_what_changes(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, None).await;
    let defaults = h.get("/v1/shopify/settings").await;
    assert_eq!(defaults.status, StatusCode::OK, "{}", defaults.body);
    assert_eq!(defaults.body["weekly_rescan"], false);
    assert_eq!(defaults.body["notification_email"], Value::Null);
    assert_eq!(defaults.body["alt_text_max_characters"], 150);
    assert_eq!(defaults.body["ai_budget_micro_usd"], 500_000);
    assert_eq!(defaults.body["ai_budget_max_micro_usd"], 500_000);
    assert_eq!(defaults.body["storefront_password_set"], false);
    assert_eq!(defaults.body["entitlements"]["plan"], "free");

    let saved = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"notification_email": "owner@demo-store.example",
                        "alt_text_max_characters": 120, "ai_budget_micro_usd": 250_000})),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.body["notification_email"], "owner@demo-store.example");
    assert_eq!(saved.body["alt_text_max_characters"], 120);
    assert_eq!(saved.body["ai_budget_micro_usd"], 250_000);

    // Fields left out stay; null clears the address.
    let cleared = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"notification_email": null})),
        )
        .await;
    assert_eq!(cleared.body["notification_email"], Value::Null);
    assert_eq!(cleared.body["alt_text_max_characters"], 120);

    let bad = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(
                json!({"notification_email": "nope", "alt_text_max_characters": 10,
                        "ai_budget_micro_usd": 9_000_000, "storefront_password": ""}),
            ),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    let mut fields: Vec<&str> = bad.body["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["field"].as_str().unwrap())
        .collect();
    fields.sort_unstable();
    assert_eq!(
        fields,
        [
            "ai_budget_micro_usd",
            "alt_text_max_characters",
            "notification_email",
            "storefront_password"
        ]
    );
    let after = h.get("/v1/shopify/settings").await;
    assert_eq!(
        after.body["alt_text_max_characters"], 120,
        "a refused update changes nothing"
    );

    let weekly = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"weekly_rescan": true})),
        )
        .await;
    assert_eq!(weekly.status, StatusCode::FORBIDDEN, "Free scans monthly");
    let unknown = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"theme": "dark"})),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_storefront_password_is_sealed_never_returned_and_can_be_cleared(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, None).await;
    let secret = "open-sesame-123";
    let saved = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"storefront_password": secret})),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.body["storefront_password_set"], true);
    assert!(!saved.body.to_string().contains(secret));
    let (ct, key): (Vec<u8>, String) = sqlx::query_as(
        "select storefront_password_ct, storefront_password_key_id from sites where id = $1",
    )
    .bind(h.site)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(key, "k1");
    assert!(!String::from_utf8_lossy(&ct).contains(secret));
    let keys = KeyRing::parse(KEYS).unwrap();
    let opened = keys
        .open_string(
            "k1",
            &ct,
            format!("sites/storefront_password/{}", h.site).as_bytes(),
        )
        .unwrap();
    assert_eq!(secrecy::ExposeSecret::expose_secret(&opened), secret);
    let audit: Value = sqlx::query_scalar(
        "select data from audit_log where tenant_id = $1 and action = 'settings.updated'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(secret));
    assert_eq!(audit["storefront_password"], "set");

    let cleared = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"storefront_password": null})),
        )
        .await;
    assert_eq!(cleared.body["storefront_password_set"], false);
    let left: Option<Vec<u8>> =
        sqlx::query_scalar("select storefront_password_ct from sites where id = $1")
            .bind(h.site)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert!(left.is_none());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_master_keys_saving_a_password_is_unavailable_and_changes_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let res = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"storefront_password": "x", "alt_text_max_characters": 99})),
        )
        .await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    let after = h.get("/v1/shopify/settings").await;
    assert_eq!(
        after.body["alt_text_max_characters"], 150,
        "the whole update was refused"
    );
}

// --- Statement --------------------------------------------------------------------------

fn statement(organization: &str) -> Value {
    json!({
        "organization": organization,
        "contact": {"email": "access@demo-store.example", "phone": "", "postal_address": "",
                    "form_url": "https://demo-store.example/contact", "response_time": "5 working days"},
        "measures": ["We test with a screen reader."],
        "limitations": [{"description": "Some old PDFs", "reason": "Scanned", "alternative": "Email us"}],
        "compatibility": "Current browsers."
    })
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_statement_draft_is_updated_in_place(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    let empty = h.get("/v1/shopify/statement").await;
    assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
    assert_eq!(empty.body, json!({"draft": null, "versions": []}));

    let first = h
        .call(
            "PUT",
            "/v1/shopify/statement",
            Some(statement("Demo Store")),
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(first.body["draft"]["organization"], "Demo Store");
    assert_eq!(first.body["versions"].as_array().unwrap().len(), 1);
    assert_eq!(first.body["versions"][0]["version"], 1);
    assert_eq!(first.body["versions"][0]["status"], "draft");

    let second = h
        .call(
            "PUT",
            "/v1/shopify/statement",
            Some(statement("Demo Store Ltd")),
        )
        .await;
    assert_eq!(second.body["draft"]["organization"], "Demo Store Ltd");
    assert_eq!(
        second.body["versions"].as_array().unwrap().len(),
        1,
        "same draft, no new version"
    );

    // After a version is published, the next save starts version 2.
    sqlx::query(
        "update statements set status = 'published', published_at = now() where site_id = $1",
    )
    .bind(h.site)
    .execute(&h.owner)
    .await
    .unwrap();
    let third = h
        .call(
            "PUT",
            "/v1/shopify/statement",
            Some(statement("Demo Store Ltd")),
        )
        .await;
    assert_eq!(third.body["versions"].as_array().unwrap().len(), 2);
    assert_eq!(third.body["versions"][0]["version"], 2);
    assert_eq!(third.body["versions"][0]["status"], "draft");
    assert_eq!(third.body["versions"][1]["status"], "published");

    let mut bad = statement("Demo Store");
    bad["contact"]["form_url"] = json!("http://demo-store.example/contact");
    bad["contact"]["email"] = json!("not an email");
    bad["measures"] = json!(vec!["x"; 51]);
    let res = h.call("PUT", "/v1/shopify/statement", Some(bad)).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let fields: Vec<&str> = res.body["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["field"].as_str().unwrap())
        .collect();
    assert!(
        fields.contains(&"contact.form_url")
            && fields.contains(&"contact.email")
            && fields.contains(&"measures")
    );
    let wrong_shape = h
        .call(
            "PUT",
            "/v1/shopify/statement",
            Some(json!({"organization": 3})),
        )
        .await;
    assert_eq!(wrong_shape.status, StatusCode::UNPROCESSABLE_ENTITY);
}

// --- Plans (audit M3) ---------------------------------------------------------------------

fn partner(server: &MockServer) -> PartnerPlans {
    PartnerPlans::new(
        PartnerCredentials {
            organization: billing::PartnerOrganizationId::parse("424242").unwrap(),
            access_token: SecretString::from("partner-test-token"),
        },
        billing::AppGid::parse("gid://shopify/App/1234").unwrap(),
        Some(url::Url::parse(&server.uri()).unwrap()),
    )
    .unwrap()
}

fn growth_subscription() -> Value {
    let now = time::OffsetDateTime::now_utc();
    let fmt = |at: time::OffsetDateTime| {
        at.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    };
    json!({"data": {"activeSubscription": {
        "shop": {"id": "gid://shopify/Shop/5678"},
        "billingPeriod": "EVERY_30_DAYS",
        "cancelAtEndOfCycle": false,
        "trialEndsAt": null,
        "currentBillingCycle": {
            "startTime": fmt(now - time::Duration::days(10)),
            "endTime": fmt(now + time::Duration::days(20))
        },
        "items": [{"handle": "growth", "price": {
            "__typename": "FlatRatePrice", "active": true, "currency": "USD", "amount": "199.00"}}],
        "pendingUpdate": null
    }}})
}

async fn record_shop_gid(h: &Harness) {
    sqlx::query("update shopify_shops set shop_gid = 'gid://shopify/Shop/5678' where id = $1")
        .bind(h.shop)
        .execute(&h.owner)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_confirmed_plan_sets_the_entitlements_and_is_not_asked_again_within_five_minutes(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/424242/api/2026-10/graphql.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(growth_subscription()))
        .mount(&server)
        .await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    record_shop_gid(&h).await;

    let first = h.get("/v1/shopify/overview").await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(first.body["entitlements"]["plan"], "growth");
    assert_eq!(first.body["entitlements"]["scan_cadence"], "daily");
    assert_eq!(
        first.body["entitlements"]["alt_text_drafts"]["limit"],
        10_000
    );
    let settings = h.get("/v1/shopify/settings").await;
    assert_eq!(settings.body["ai_budget_max_micro_usd"], 20_000_000);
    h.get("/v1/shopify/overview").await;
    h.get("/v1/shopify/overview").await;
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "fresh state costs no call"
    );

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(
        request.headers["x-shopify-access-token"],
        "partner-test-token"
    );
    let stored: String = sqlx::query_scalar("select plan from shop_billing where shop_id = $1")
        .bind(h.shop)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(stored, "growth");
    assert_eq!(
        h.count("select count(*) from audit_log where tenant_id = $1 and action = 'billing.event'")
            .await,
        1
    );
    // Weekly rescans are now allowed.
    let weekly = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"weekly_rescan": true})),
        )
        .await;
    assert_eq!(weekly.status, StatusCode::OK, "{}", weekly.body);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_plan_handle_query_parameter_is_ignored_and_grants_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"data": {"activeSubscription": null}})),
        )
        .mount(&server)
        .await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    record_shop_gid(&h).await;
    for handle in [
        "pro",
        "starter",
        "free",
        "../../etc",
        "x".repeat(500).as_str(),
    ] {
        let res = h
            .get(&format!("/v1/shopify/overview?plan_handle={handle}"))
            .await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body["entitlements"]["plan"], "free", "{handle}");
    }
    let stored: Option<String> =
        sqlx::query_scalar("select plan from shop_billing where shop_id = $1")
            .bind(h.shop)
            .fetch_optional(&h.owner)
            .await
            .unwrap()
            .flatten();
    assert_ne!(stored.as_deref(), Some("pro"));
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "a \"no plan\" answer is cached; the parameter is no reason to ask again"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_shop_that_reloads_in_a_loop_gets_one_call_for_no_plan_and_three_a_minute_at_most(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"data": {"activeSubscription": null}})),
        )
        .mount(&server)
        .await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    record_shop_gid(&h).await;
    for _ in 0..40 {
        assert_eq!(h.get("/v1/shopify/overview").await.status, StatusCode::OK);
    }
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "forty loads of a shop with no plan cost one call"
    );

    // Even when its stored answer keeps looking stale, the shop's share of the pacer is three
    // calls a minute.
    for _ in 0..40 {
        sqlx::query(
            "update shop_billing set last_confirmed_at = now() - interval '1 hour',
                                     last_attempt_at = now() - interval '1 hour'",
        )
        .execute(&h.owner)
        .await
        .unwrap();
        assert_eq!(h.get("/v1/shopify/overview").await.status, StatusCode::OK);
    }
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        3,
        "one cached answer, then the shop's share of three calls a minute"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_downgrade_takes_the_stored_ai_budget_down_to_the_new_ceiling_in_the_same_transaction(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(growth_subscription()))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"data": {"activeSubscription": null}})),
        )
        .mount(&server)
        .await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    record_shop_gid(&h).await;
    h.get("/v1/shopify/overview").await;
    let set = h
        .call(
            "PUT",
            "/v1/shopify/settings",
            Some(json!({"ai_budget_micro_usd": 15_000_000})),
        )
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);

    // Shopify now says the subscription is gone; the stored plan falls to the free ceiling.
    sqlx::query(
        "update shop_billing set last_confirmed_at = now() - interval '1 hour',
                                 last_attempt_at = now() - interval '1 hour'",
    )
    .execute(&h.owner)
    .await
    .unwrap();
    h.get("/v1/shopify/overview").await;
    let stored: i64 = sqlx::query_scalar(
        "select (settings ->> 'ai_budget_micro_usd')::bigint from sites where id = $1",
    )
    .bind(h.site)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(
        stored, 500_000,
        "the stored budget no longer exceeds the ceiling"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_failed_partner_call_keeps_the_stored_plan_and_backs_off(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    record_shop_gid(&h).await;
    let first = h.get("/v1/shopify/overview").await;
    assert_eq!(first.status, StatusCode::OK, "the overview still loads");
    assert_eq!(first.body["entitlements"]["plan"], "free");
    h.get("/v1/shopify/overview").await;
    h.get("/v1/shopify/overview").await;
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "one minute of backoff after a failure"
    );
    let failures: i32 =
        sqlx::query_scalar("select consecutive_failures from shop_billing where shop_id = $1")
            .bind(h.shop)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!(failures, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_a_recorded_shop_id_no_partner_call_is_made(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let server = MockServer::start().await;
    let h = harness(opts, conn, false, Some(partner(&server))).await;
    let res = h.get("/v1/shopify/overview").await;
    assert_eq!(res.body["entitlements"]["plan"], "free");
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn draft_usage_counts_successful_draft_calls_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    for (task, outcome) in [
        ("alt_text", "ok"),
        ("alt_text", "needs_review"),
        ("alt_text_escalated", "ok"),
        ("alt_text", "error"),
        ("alt_text", "refused"),
        ("grade_alt_text", "ok"),
    ] {
        sqlx::query(
            "insert into ai_calls (id, tenant_id, task, model, mode, prompt_version, input_tokens,
                                   output_tokens, cost_micro_usd, cost_is_estimate, outcome,
                                   attempts, duration_ms, started_at)
             values (gen_random_uuid(), $1, $2, 'claude-haiku-5-5', 'sync', 'v1', 10, 5, 100, false,
                     $3, 1, 20, now())",
        )
        .bind(h.tenant)
        .bind(task)
        .bind(outcome)
        .execute(&h.owner)
        .await
        .unwrap();
    }
    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(overview.body["entitlements"]["alt_text_drafts"]["used"], 3);
}

/// Security audit M1 (ADR-213, ADR-096): a draft the engine flagged shows its flags on the card
/// and is approved only with an explicit `confirm_flagged`; an unflagged draft is unaffected.
#[sqlx::test(migrations = "../db/migrations")]
async fn a_flagged_draft_is_approved_only_with_an_explicit_confirmation(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "manual", 5, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(90.0),
            false,
            &["1.1.1"],
        )
        .await;
    let fix = h.fix(finding, "proposed", "A blue shoe", true).await;
    sqlx::query(
        "update fixes set diff = jsonb_set(diff, '{flags}',
                 '[\"suspected_prompt_injection\", \"unknown_flag\", \"instruction_like_text_seen\"]')
          where id = $1",
    )
    .bind(fix)
    .execute(&h.owner)
    .await
    .unwrap();

    let queue = h.get("/v1/shopify/fixes").await;
    assert_eq!(
        queue.body["items"][0]["change"]["flags"],
        json!(["instruction_like_text_seen", "suspected_prompt_injection"]),
        "known flags only, sorted"
    );

    let uri = format!("/v1/shopify/fixes/{fix}/approve");
    for refused in [uri.clone(), format!("{uri}?confirm_flagged=false")] {
        let answer = h.call("POST", &refused, None).await;
        assert_eq!(
            answer.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            answer.body
        );
        assert_eq!(answer.body["errors"][0]["field"], "confirm_flagged");
    }
    assert_eq!(
        h.count(
            "select count(*) from jobs where tenant_id = $1 and queue = 'shopify.apply_data_fix'"
        )
        .await,
        0,
        "nothing was queued"
    );
    let status: String = sqlx::query_scalar("select status from fixes where id = $1")
        .bind(fix)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(status, "proposed");

    let confirmed = h
        .call("POST", &format!("{uri}?confirm_flagged=true"), None)
        .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    assert_eq!(confirmed.body["status"], "approved");

    // An unflagged draft needs no confirmation.
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(80.0),
            false,
            &["1.1.1"],
        )
        .await;
    let plain_fix = h.fix(finding, "proposed", "A red shoe", true).await;
    let ok = h
        .call(
            "POST",
            &format!("/v1/shopify/fixes/{plain_fix}/approve"),
            None,
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
}

// --- Regressions (ADR-310, ADR-311) ----------------------------------------------------

async fn set_plan(h: &Harness, plan: &str) {
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval,
                                   last_confirmed_at)
         values ($1, $2, 'paid', $3, 'monthly', now())
         on conflict (shop_id) do update set plan = excluded.plan, standing = 'paid'",
    )
    .bind(h.shop)
    .bind(h.tenant)
    .bind(plan)
    .execute(&h.owner)
    .await
    .unwrap();
}

/// A regression record for `scan`, with one listed finding.
async fn regression(h: &Harness, scan: Uuid, finding: Uuid, days_ago: i32) -> Uuid {
    sqlx::query_scalar(
        "insert into regressions (id, tenant_id, site_id, scan_id, new_count, reappeared_count,
                                  findings_seen, pass_rate, previous_pass_rate, items,
                                  alert_state, detected_at)
         values (gen_random_uuid(), $1, $2, $3, 1, 0, 4, 90.5, 93.25,
                 jsonb_build_array(jsonb_build_object('finding_id', $4::text,
                     'rule_id', 'rs-media-alt-empty', 'impact', 'critical',
                     'criteria', jsonb_build_array('1.1.1'), 'kind', 'new')),
                 'queued', now() - make_interval(days => $5))
         returning id",
    )
    .bind(h.tenant)
    .bind(h.site)
    .bind(scan)
    .bind(finding)
    .bind(days_ago)
    .fetch_one(&h.owner)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_growth_shop_sees_its_regressions_in_a_list_and_a_banner_until_it_dismisses_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    set_plan(&h, "growth").await;
    let first = h.scan("succeeded", "scheduled", 120, None).await;
    let scan = h.scan("succeeded", "scheduled", 60, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            Some(8.0),
            false,
            &["1.1.1"],
        )
        .await;
    let _ = first;
    let record = regression(&h, scan, finding, 0).await;

    let list = h.get("/v1/shopify/regressions").await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    assert_eq!(list.body["gate"], "allowed");
    assert_eq!(list.body["unlocked_by"], Value::Null);
    let item = &list.body["items"][0];
    assert_eq!(item["id"], record.to_string());
    assert_eq!(item["new_count"], 1);
    assert_eq!(item["pass_rate"], 90.5);
    assert_eq!(item["previous_pass_rate"], 93.25);
    assert_eq!(item["items"][0]["finding_id"], finding.to_string());
    assert_eq!(item["items"][0]["kind"], "new");
    // The sentence comes from the catalog, not from the stored row.
    assert!(item["items"][0]["title"].as_str().unwrap().len() > 10);

    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(overview.body["regression_banner"]["id"], record.to_string());

    let dismissed = h
        .call(
            "POST",
            &format!("/v1/shopify/regressions/{record}/dismiss"),
            None,
        )
        .await;
    assert_eq!(dismissed.status, StatusCode::NO_CONTENT);
    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(overview.body["regression_banner"], Value::Null);
    let list = h.get("/v1/shopify/regressions").await;
    assert_eq!(list.body["items"][0]["dismissed"], true, "the record stays");
    let audited: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where tenant_id = $1 and action = 'regression.dismissed'",
    )
    .bind(h.tenant)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(audited, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_banner_ends_after_a_week(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    set_plan(&h, "pro").await;
    let scan = h.scan("succeeded", "scheduled", 60, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            None,
            false,
            &["1.1.1"],
        )
        .await;
    regression(&h, scan, finding, 9).await;
    let overview = h.get("/v1/shopify/overview").await;
    assert_eq!(overview.body["regression_banner"], Value::Null);
    let list = h.get("/v1/shopify/regressions").await;
    assert_eq!(list.body["items"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn plans_without_regression_alerts_see_nothing_and_are_told_which_plan_unlocks_them(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "scheduled", 60, None).await;
    let finding = h
        .finding(
            scan,
            "rs-media-alt-empty",
            "critical",
            "open",
            "data",
            None,
            false,
            &["1.1.1"],
        )
        .await;
    regression(&h, scan, finding, 0).await;
    // Free (no plan row) and Starter are both locked, and both are told Growth unlocks it.
    for plan in [None, Some("starter")] {
        if let Some(plan) = plan {
            set_plan(&h, plan).await;
        }
        let list = h.get("/v1/shopify/regressions").await;
        assert_eq!(list.status, StatusCode::OK);
        assert_eq!(list.body["gate"], "locked", "{plan:?}");
        assert_eq!(list.body["unlocked_by"], "growth", "{plan:?}");
        assert_eq!(list.body["items"], json!([]), "{plan:?}");
        let overview = h.get("/v1/shopify/overview").await;
        assert_eq!(overview.body["regression_banner"], Value::Null, "{plan:?}");
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn another_shops_regression_is_not_found_and_stays_undismissed(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    set_plan(&h, "growth").await;
    let (their_scan, their_finding, _) = other_shop(&h).await;
    let their_tenant: Uuid = sqlx::query_scalar("select tenant_id from scans where id = $1")
        .bind(their_scan)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let their_site: Uuid = sqlx::query_scalar("select site_id from scans where id = $1")
        .bind(their_scan)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let theirs: Uuid = sqlx::query_scalar(
        "insert into regressions (id, tenant_id, site_id, scan_id, new_count, reappeared_count,
                                  findings_seen, items, alert_state)
         values (gen_random_uuid(), $1, $2, $3, 1, 0, 1,
                 jsonb_build_array(jsonb_build_object('finding_id', $4::text, 'rule_id', 'x',
                    'impact', 'minor', 'criteria', jsonb_build_array('1.1.1'), 'kind', 'new')),
                 'queued') returning id",
    )
    .bind(their_tenant)
    .bind(their_site)
    .bind(their_scan)
    .bind(their_finding)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let list = h.get("/v1/shopify/regressions").await;
    assert_eq!(list.body["items"], json!([]), "nothing of theirs is listed");
    let refused = h
        .call(
            "POST",
            &format!("/v1/shopify/regressions/{theirs}/dismiss"),
            None,
        )
        .await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    let bad = h
        .call("POST", "/v1/shopify/regressions/not-an-id/dismiss", None)
        .await;
    assert_eq!(bad.status, StatusCode::NOT_FOUND);
    let untouched: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select dismissed_at from regressions where id = $1")
            .bind(theirs)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert!(untouched.is_none());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn regression_operations_need_a_session(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = plain(opts, conn).await;
    for (verb, uri) in [
        ("GET", "/v1/shopify/regressions".to_owned()),
        (
            "POST",
            format!("/v1/shopify/regressions/{}/dismiss", Uuid::nil()),
        ),
    ] {
        let res = api::app(h.state.clone())
            .oneshot(
                Request::builder()
                    .method(verb)
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{verb} {uri}");
    }
}

// --- Agency links (ADR-313, ADR-314) ---------------------------------------------------

const OTHER_SHOP: &str = "second-store.myshopify.com";

/// A signed-in dashboard user with a live session token.
async fn dashboard_user(h: &Harness, name: &str) -> String {
    let id = Uuid::now_v7();
    let token = format!("test-session-{id}");
    sqlx::query("insert into users (id, email, display_name) values ($1, $2, $3)")
        .bind(id)
        .bind(format!("{name}-{id}@example.com"))
        .bind(name)
        .execute(&h.owner)
        .await
        .unwrap();
    sqlx::query(
        "insert into web_sessions (token_hash, user_id, idle_expires_at, absolute_expires_at)
         values (sha256(convert_to($1, 'UTF8')), $2, now() + interval '7 days',
                 now() + interval '30 days')",
    )
    .bind(&token)
    .bind(id)
    .execute(&h.owner)
    .await
    .unwrap();
    token
}

/// A dashboard call with `Authorization: Session <token>`.
async fn dash(
    h: &Harness,
    token: Option<&str>,
    verb: &str,
    uri: &str,
    body: Option<Value>,
) -> Answer {
    let mut request = Request::builder().method(verb).uri(uri);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Session {token}"));
    }
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let res = api::app(h.state.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Answer {
        status,
        content_type: String::new(),
        headers,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        bytes,
    }
}

/// Installs a second shop by opening its first session.
async fn second_shop(h: &Harness) {
    let res = h
        .call_for(OTHER_SHOP, Some(STAFF), "POST", "/v1/shopify/session", None)
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
}

/// An organization of the user's, and a fresh code for it.
async fn org_and_code(h: &Harness, token: &str, name: &str) -> (String, String) {
    let org = dash(
        h,
        Some(token),
        "POST",
        "/v1/agency/organizations",
        Some(json!({"name": name})),
    )
    .await;
    assert_eq!(org.status, StatusCode::CREATED, "{}", org.body);
    let id = org.body["id"].as_str().unwrap().to_owned();
    let code = dash(
        h,
        Some(token),
        "POST",
        &format!("/v1/agency/organizations/{id}/link-codes"),
        None,
    )
    .await;
    assert_eq!(code.status, StatusCode::CREATED, "{}", code.body);
    (id, code.body["code"].as_str().unwrap().to_owned())
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_agency_links_a_store_the_merchant_approves_and_loses_it_when_the_merchant_revokes(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    let scan = h.scan("succeeded", "scheduled", 60, None).await;
    h.finding(
        scan,
        "rs-media-alt-empty",
        "critical",
        "open",
        "data",
        Some(8.0),
        false,
        &["1.1.1"],
    )
    .await;
    let ada = dashboard_user(&h, "ada").await;
    let (_org, code) = org_and_code(&h, &ada, "Ada Agency").await;

    // Nothing is linked by a code alone.
    let before = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    assert_eq!(before.status, StatusCode::OK);
    assert_eq!(before.body["stores"].as_array().unwrap().len(), 0);

    // The merchant sees who is asking, then approves; the code may be typed in lower case.
    let typed = code.to_lowercase();
    let preview = h
        .call(
            "POST",
            "/v1/shopify/agency-links/preview",
            Some(json!({"code": typed})),
        )
        .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
    assert_eq!(preview.body["organization_name"], "Ada Agency");
    let approved = h
        .call(
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(approved.status, StatusCode::CREATED, "{}", approved.body);
    let link = approved.body["id"].as_str().unwrap().to_owned();
    let listed = h.get("/v1/shopify/agency-links").await;
    assert_eq!(listed.body["links"][0]["organization_name"], "Ada Agency");

    // The agency's overview now shows counts, no finding content.
    let after = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    let store = &after.body["stores"][0];
    assert_eq!(store["shop_domain"], SHOP, "{}", after.body);
    assert_eq!(store["open_findings"], 1);
    assert_eq!(store["open_serious"], 1);
    assert_eq!(store["pass_rate"], 83.3);
    assert!(
        !after.body.to_string().contains("rs-media-alt-empty"),
        "the overview carried finding content"
    );

    // Revoke from App Home: the very next read lacks the store.
    let revoked = h
        .call("DELETE", &format!("/v1/shopify/agency-links/{link}"), None)
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    let gone = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    assert_eq!(
        gone.body["stores"].as_array().unwrap().len(),
        0,
        "a revoked store still showed"
    );
    let again = h
        .call("DELETE", &format!("/v1/shopify/agency-links/{link}"), None)
        .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);

    // The decisions are in the audit log, with no names in them.
    let actions: Vec<String> = sqlx::query_scalar(
        "select action from audit_log where action like 'agency.%' order by at, id",
    )
    .fetch_all(&h.owner)
    .await
    .unwrap();
    assert_eq!(actions, ["agency.link_approved", "agency.link_revoked"]);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_agency_never_sees_a_store_that_did_not_grant_a_link_or_another_agencys_link(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    second_shop(&h).await;
    let (ada, eve) = (
        dashboard_user(&h, "ada").await,
        dashboard_user(&h, "eve").await,
    );
    let (ada_org, code) = org_and_code(&h, &ada, "Ada Agency").await;
    let (_eve_org, _eve_code) = org_and_code(&h, &eve, "Eve Agency").await;

    // Only the first shop approves Ada's code.
    let approved = h
        .call(
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(approved.status, StatusCode::CREATED);
    let link = approved.body["id"].as_str().unwrap().to_owned();

    let ada_view = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    let domains: Vec<&str> = ada_view.body["stores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["shop_domain"].as_str().unwrap())
        .collect();
    assert_eq!(domains, [SHOP], "the unlinked second store appeared");

    // Eve is in another organization: she sees nothing, cannot end Ada's link, and cannot make
    // codes for Ada's organization.
    let eve_view = dash(&h, Some(&eve), "GET", "/v1/agency/stores", None).await;
    assert_eq!(eve_view.body["stores"].as_array().unwrap().len(), 0);
    let ended = dash(
        &h,
        Some(&eve),
        "DELETE",
        &format!("/v1/agency/links/{link}"),
        None,
    )
    .await;
    assert_eq!(ended.status, StatusCode::NOT_FOUND);
    let minted = dash(
        &h,
        Some(&eve),
        "POST",
        &format!("/v1/agency/organizations/{ada_org}/link-codes"),
        None,
    )
    .await;
    assert_eq!(minted.status, StatusCode::NOT_FOUND);
    let still = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    assert_eq!(still.body["stores"].as_array().unwrap().len(), 1);

    // The second shop cannot see or revoke the first shop's link.
    let theirs = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "GET",
            "/v1/shopify/agency-links",
            None,
        )
        .await;
    assert_eq!(theirs.body["links"].as_array().unwrap().len(), 0);
    let stolen = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "DELETE",
            &format!("/v1/shopify/agency-links/{link}"),
            None,
        )
        .await;
    assert_eq!(stolen.status, StatusCode::NOT_FOUND);
    let still = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    assert_eq!(still.body["stores"].as_array().unwrap().len(), 1);

    // The agency ends it from its side: the merchant's list empties as well.
    let ended = dash(
        &h,
        Some(&ada),
        "DELETE",
        &format!("/v1/agency/links/{link}"),
        None,
    )
    .await;
    assert_eq!(ended.status, StatusCode::NO_CONTENT);
    assert_eq!(
        h.get("/v1/shopify/agency-links").await.body["links"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let none = dash(&h, Some(&ada), "GET", "/v1/agency/stores", None).await;
    assert_eq!(none.body["stores"].as_array().unwrap().len(), 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn codes_are_single_use_expire_and_a_shop_that_guesses_is_stopped(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    second_shop(&h).await;
    let ada = dashboard_user(&h, "ada").await;
    let (_org, code) = org_and_code(&h, &ada, "Ada Agency").await;

    let first = h
        .call(
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(first.status, StatusCode::CREATED);
    let reused = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": code})),
        )
        .await;
    assert_eq!(
        reused.status,
        StatusCode::NOT_FOUND,
        "a used code linked a second shop"
    );

    // An expired code.
    sqlx::query("update agency_link_codes set expires_at = now() - interval '1 minute'")
        .execute(&h.owner)
        .await
        .unwrap();
    let fresh = dash(&h, Some(&ada), "GET", "/v1/agency/organizations", None).await;
    let org = fresh.body["organizations"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let stale = dash(
        &h,
        Some(&ada),
        "POST",
        &format!("/v1/agency/organizations/{org}/link-codes"),
        None,
    )
    .await;
    let stale_code = stale.body["code"].as_str().unwrap().to_owned();
    sqlx::query("update agency_link_codes set expires_at = now() - interval '1 minute'")
        .execute(&h.owner)
        .await
        .unwrap();
    let expired = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": stale_code})),
        )
        .await;
    assert_eq!(
        expired.status,
        StatusCode::NOT_FOUND,
        "an expired code linked"
    );

    // Wrong guesses are counted per shop; past the limit even a valid code is refused.
    let (_, good) = {
        let minted = dash(
            &h,
            Some(&ada),
            "POST",
            &format!("/v1/agency/organizations/{org}/link-codes"),
            None,
        )
        .await;
        (
            org.clone(),
            minted.body["code"].as_str().unwrap().to_owned(),
        )
    };
    // The reused and the expired code above were two; three more make five.
    for _ in 0..3 {
        let wrong = h
            .call_for(
                OTHER_SHOP,
                Some(STAFF),
                "POST",
                "/v1/shopify/agency-links",
                Some(json!({"code": "ZZZZZ-ZZZZZ"})),
            )
            .await;
        assert_eq!(wrong.status, StatusCode::NOT_FOUND);
    }
    let blocked = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": good})),
        )
        .await;
    assert_eq!(
        blocked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        blocked.body
    );
    let preview = h
        .call_for(
            OTHER_SHOP,
            Some(STAFF),
            "POST",
            "/v1/shopify/agency-links/preview",
            Some(json!({"code": good})),
        )
        .await;
    assert_eq!(preview.status, StatusCode::TOO_MANY_REQUESTS);
    // The other shop's counter is its own.
    let shop_one = h
        .call(
            "POST",
            "/v1/shopify/agency-links",
            Some(json!({"code": good})),
        )
        .await;
    assert_eq!(shop_one.status, StatusCode::CREATED, "{}", shop_one.body);

    // A code that cannot be one is just as unwelcome.
    let junk = h
        .call(
            "POST",
            "/v1/shopify/agency-links/preview",
            Some(json!({"code": "hello"})),
        )
        .await;
    assert_eq!(junk.status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_agency_routes_need_the_right_kind_of_session(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = plain(opts, conn).await;
    for (verb, uri) in [
        ("GET", "/v1/agency/organizations"),
        ("POST", "/v1/agency/organizations"),
        ("GET", "/v1/agency/stores"),
        (
            "POST",
            "/v1/agency/organizations/00000000-0000-0000-0000-000000000001/link-codes",
        ),
        (
            "DELETE",
            "/v1/agency/links/00000000-0000-0000-0000-000000000001",
        ),
    ] {
        let answer = dash(&h, None, verb, uri, Some(json!({"name": "x"}))).await;
        assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{verb} {uri}");
    }
    // A Shopify session is not a dashboard session, and the other way round.
    let token = id_token(SHOP, STAFF);
    let wrong = dash(&h, Some(&token), "GET", "/v1/agency/stores", None).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let ada = dashboard_user(&h, "ada").await;
    let wrong = dash(&h, Some(&ada), "GET", "/v1/shopify/agency-links", None).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    for (verb, uri) in [
        ("GET", "/v1/shopify/agency-links"),
        ("POST", "/v1/shopify/agency-links"),
        ("POST", "/v1/shopify/agency-links/preview"),
        (
            "DELETE",
            "/v1/shopify/agency-links/00000000-0000-0000-0000-000000000001",
        ),
    ] {
        let res = api::app(h.state.clone())
            .oneshot(
                Request::builder()
                    .method(verb)
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{verb} {uri}");
    }
}
