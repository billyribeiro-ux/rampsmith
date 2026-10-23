//! The free scanner's api (ADR-267): service authentication, the address guard, Turnstile
//! checked server-side before anything is queued, the daily limits and the cache, all from the
//! database.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use api::AppState;
use api::free_scan::{FreeScanSettings, FreeScans};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use contracts::{FreeScanExample, FreeScanFailure, FreeScanResult};
use db::Db;
use http_body_util::BodyExt;
use secrecy::SecretString;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod support;

use support::app_login_pool;

const TOKEN: &str = "0123456789abcdef0123456789abcdef-service";
const CHALLENGE: &str = "turnstile-token-from-the-widget";

struct Harness {
    state: AppState,
    owner: PgPool,
    turnstile: MockServer,
}

async fn harness(opts: PgPoolOptions, conn: PgConnectOptions, configured: bool) -> Harness {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let turnstile = MockServer::start().await;
    let db = Db::from_pool(app_login_pool(opts, conn).await);
    let mut state = AppState::new(db);
    if configured {
        state = state.with_free_scans(
            FreeScans::new(FreeScanSettings {
                service_token: SecretString::from(TOKEN),
                turnstile_secret: SecretString::from("turnstile-secret"),
                turnstile_origin: url::Url::parse(&turnstile.uri()).unwrap(),
            })
            .unwrap(),
        );
    }
    if configured {
        // An engine with a sandboxed Chromium is serving free scans (ADR-280).
        beat(&owner, "engine-test", "0 seconds").await;
    }
    Harness {
        state,
        owner,
        turnstile,
    }
}

/// Records an engine's heartbeat `age` ago.
async fn beat(owner: &PgPool, worker: &str, age: &str) {
    sqlx::query(
        "insert into free_scan_engines (worker_id, beat_at) values ($1, now() - $2::interval)
         on conflict (worker_id) do update set beat_at = excluded.beat_at",
    )
    .bind(worker)
    .bind(age)
    .execute(owner)
    .await
    .unwrap();
}

async fn solved(h: &Harness) {
    Mock::given(method("POST"))
        .and(path("/turnstile/v0/siteverify"))
        .and(body_string_contains("secret=turnstile-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true })))
        .mount(&h.turnstile)
        .await;
}

async fn call(
    state: &AppState,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = api::app(state.clone()).oneshot(request).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn post(token: Option<&str>, body: &Value) -> Request<Body> {
    let mut request =
        Request::post("/v1/free-scans").header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}

fn ask(url: &str, ip: &str) -> Value {
    json!({ "url": url, "turnstile_token": CHALLENGE, "client_ip": ip })
}

async fn count(owner: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
        .fetch_one(owner)
        .await
        .unwrap()
}

fn result_for(domain: &str) -> Value {
    serde_json::to_value(FreeScanResult {
        domain: domain.to_owned(),
        scanned_at: "2026-10-22T10:00:00Z".to_owned(),
        pages: vec![format!("https://{domain}/")],
        checks_passed: 30,
        checks_run: 34,
        failures: vec![FreeScanFailure {
            rule_id: "image-alt".to_owned(),
            title: "Images without a text alternative".to_owned(),
            criterion: "1.1.1".to_owned(),
            count: 2,
            examples: vec![FreeScanExample {
                page: format!("https://{domain}/"),
                snippet: "<img src=\"/a.jpg\">".to_owned(),
            }],
        }],
    })
    .unwrap()
}

async fn finish(owner: &PgPool, id: &str, status: &str, domain: &str) {
    let id: uuid::Uuid = id.parse().unwrap();
    match status {
        "complete" => sqlx::query(
            "update free_scans set status = 'complete', finished_at = now(), result = $2 where id = $1",
        )
        .bind(id)
        .bind(result_for(domain))
        .execute(owner)
        .await
        .unwrap(),
        _ => sqlx::query(
            "update free_scans set status = 'refused', refusal = 'robots', finished_at = now() where id = $1",
        )
        .bind(id)
        .execute(owner)
        .await
        .unwrap(),
    };
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_its_secrets_the_free_scanner_answers_503(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, false).await;
    let (status, _, body) =
        call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(count(&h.owner, "free_scans").await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn only_the_web_server_may_ask(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = harness(opts, conn, true).await;
    for token in [
        None,
        Some("wrong"),
        Some("0123456789abcdef0123456789abcdef-servicf"),
    ] {
        let (status, _, body) = call(&h.state, post(token, &ask("shop.com", "203.0.113.5"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    let get = Request::get(format!("/v1/free-scans/{}", uuid::Uuid::now_v7()))
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = call(&h.state, get).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.turnstile.received_requests().await.unwrap().len(), 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_address_that_is_not_a_public_site_never_reaches_cloudflare_or_the_queue(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    for url in [
        "http://127.0.0.1",
        "intranet",
        "shop.com:8443",
        "ftp://shop.com",
        // A whole public suffix is not a site (audit L1).
        "co.uk",
        "https://myshopify.com/",
        "",
    ] {
        let (status, _, body) = call(&h.state, post(Some(TOKEN), &ask(url, "203.0.113.5"))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{url}: {body}");
        assert_eq!(body["errors"][0]["field"], "url");
    }
    let (status, _, body) = call(
        &h.state,
        post(Some(TOKEN), &ask("shop.com", "not an address")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(h.turnstile.received_requests().await.unwrap().len(), 0);
    assert_eq!(count(&h.owner, "free_scans").await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_failed_challenge_queues_nothing_and_an_unreachable_one_fails_closed(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    Mock::given(method("POST"))
        .and(path("/turnstile/v0/siteverify"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({ "success": false, "error-codes": ["timeout-or-duplicate"] }),
            ),
        )
        .up_to_n_times(1)
        .mount(&h.turnstile)
        .await;
    let (status, _, body) =
        call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["errors"][0]["field"], "turnstile_token");

    // Cloudflare says the secret is wrong: the visitor can do nothing, and nothing runs.
    Mock::given(method("POST"))
        .and(path("/turnstile/v0/siteverify"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({ "success": false, "error-codes": ["invalid-input-secret"] }),
            ),
        )
        .mount(&h.turnstile)
        .await;
    let (status, _, body) =
        call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    // The web page tells "the check is down" from "the scanner is busy" by this field.
    assert_eq!(body["errors"][0]["field"], "turnstile_token");

    // Cloudflare is down.
    h.turnstile.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500).set_body_string("<html>"))
        .mount(&h.turnstile)
        .await;
    let (status, _, _) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // No token at all.
    let mut body = ask("shop.com", "203.0.113.5");
    body["turnstile_token"] = json!("");
    let (status, _, _) = call(&h.state, post(Some(TOKEN), &body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    assert_eq!(count(&h.owner, "free_scans").await, 0);
    assert_eq!(count(&h.owner, "jobs").await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_solved_challenge_queues_one_tenantless_job_and_stores_no_address(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (status, _, body) = call(
        &h.state,
        post(
            Some(TOKEN),
            &ask(" HTTPS://WWW.Shop.com/products/x ", "203.0.113.5"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["status"], "queued");
    assert_eq!(body["domain"], "shop.com");
    assert_eq!(body["cached"], false);
    let id = body["id"].as_str().unwrap().to_owned();

    let (queue, tenant): (String, Option<uuid::Uuid>) =
        sqlx::query_as("select queue, tenant_id from jobs")
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!((queue.as_str(), tenant), ("free_scan.run", None));
    let (origin, hash): (String, Vec<u8>) =
        sqlx::query_as("select origin, ip_hash from free_scans")
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!(origin, "https://www.shop.com/");
    assert_eq!(hash.len(), 32);
    let dump: String = sqlx::query_scalar("select (free_scans)::text from free_scans")
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert!(
        !dump.contains("203.0.113.5"),
        "the address was stored: {dump}"
    );

    let get = Request::get(format!("/v1/free-scans/{id}"))
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = call(&h.state, get).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "queued");
    assert_eq!(body["result"], Value::Null);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_second_request_for_a_running_domain_joins_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (_, _, first) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    let (status, _, second) = call(
        &h.state,
        post(Some(TOKEN), &ask("https://www.shop.com", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{second}");
    assert_eq!(second["id"], first["id"]);
    assert_eq!(second["cached"], true);
    assert_eq!(count(&h.owner, "jobs").await, 1);
    assert_eq!(count(&h.owner, "free_scans").await, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_finished_scan_answers_the_next_visitor_for_a_day_at_no_cost(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (_, _, first) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    finish(
        &h.owner,
        first["id"].as_str().unwrap(),
        "complete",
        "shop.com",
    )
    .await;

    let (status, _, again) = call(
        &h.state,
        post(Some(TOKEN), &ask("shop.com", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["id"], first["id"]);
    assert_eq!(again["cached"], true);
    assert_eq!(again["status"], "complete");
    assert_eq!(again["result"]["checks_passed"], 30);
    assert_eq!(again["result"]["failures"][0]["rule_id"], "image-alt");
    assert_eq!(count(&h.owner, "jobs").await, 1);

    // The cache cost the second visitor nothing: the same address can still use all three.
    for domain in ["a-shop.com", "b-shop.com", "c-shop.com"] {
        let (status, _, body) =
            call(&h.state, post(Some(TOKEN), &ask(domain, "198.51.100.9"))).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{domain}: {body}");
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_address_gets_three_scans_a_day_and_then_neither_cloudflare_nor_the_queue(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    for domain in ["a-shop.com", "b-shop.com", "c-shop.com"] {
        let (status, _, body) =
            call(&h.state, post(Some(TOKEN), &ask(domain, "203.0.113.5"))).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{domain}: {body}");
    }
    let spent = h.turnstile.received_requests().await.unwrap().len();
    let (status, headers, body) = call(
        &h.state,
        post(Some(TOKEN), &ask("d-shop.com", "203.0.113.5")),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["errors"][0]["message"], "ip");
    let wait: i64 = headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((86_300..=86_400).contains(&wait), "{wait}");
    assert_eq!(
        h.turnstile.received_requests().await.unwrap().len(),
        spent,
        "a blocked address spent a Cloudflare call"
    );
    assert_eq!(count(&h.owner, "free_scans").await, 3);
    // Another visitor is not held back by this one.
    let (status, _, _) = call(
        &h.state,
        post(Some(TOKEN), &ask("e-shop.com", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_domain_that_was_refused_cannot_be_asked_again_the_same_day(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (_, _, first) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    finish(
        &h.owner,
        first["id"].as_str().unwrap(),
        "refused",
        "shop.com",
    )
    .await;
    let (status, headers, body) = call(
        &h.state,
        post(Some(TOKEN), &ask("shop.com", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["errors"][0]["message"], "domain");
    assert!(headers.contains_key(header::RETRY_AFTER));
    let (status, _, got) = call(
        &h.state,
        Request::get(format!("/v1/free-scans/{}", first["id"].as_str().unwrap()))
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["status"], "refused");
    assert_eq!(got["refusal"], "robots");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_result_that_breaks_the_limits_is_not_served(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (_, _, first) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    let id: uuid::Uuid = first["id"].as_str().unwrap().parse().unwrap();
    let mut too_many = result_for("shop.com");
    too_many["pages"] = json!([
        "https://shop.com/",
        "https://shop.com/a",
        "https://shop.com/b",
        "https://shop.com/c"
    ]);
    sqlx::query(
        "update free_scans set status = 'complete', finished_at = now(), result = $2 where id = $1",
    )
    .bind(id)
    .bind(too_many)
    .execute(&h.owner)
    .await
    .unwrap();
    let (_, _, got) = call(
        &h.state,
        Request::get(format!("/v1/free-scans/{id}"))
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(got["status"], "failed", "{got}");
    assert_eq!(got["result"], Value::Null);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_daily_limit_covers_every_subdomain_of_a_registrable_domain(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (status, _, first) = call(
        &h.state,
        post(Some(TOKEN), &ask("a.shop.co.uk", "203.0.113.5")),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{first}");
    finish(
        &h.owner,
        first["id"].as_str().unwrap(),
        "refused",
        "a.shop.co.uk",
    )
    .await;
    // Another host under the same registrable domain, from another address: the day is spent.
    let (status, _, body) = call(
        &h.state,
        post(Some(TOKEN), &ask("b.shop.co.uk", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["errors"][0]["message"], "domain");
    // A different registrable domain under the same suffix is a different site.
    let (status, _, body) = call(
        &h.state,
        post(Some(TOKEN), &ask("other.co.uk", "198.51.100.9")),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_unknown_or_malformed_id_is_not_found(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = harness(opts, conn, true).await;
    for id in [uuid::Uuid::now_v7().to_string(), "nope".to_owned()] {
        let (status, _, _) = call(
            &h.state,
            Request::get(format!("/v1/free-scans/{id}"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn without_a_sandboxed_engine_nothing_is_spent_and_the_answer_is_503(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    // The challenge would pass, so a call to Cloudflare would show up as a received request.
    solved(&h).await;
    for stale in [None, Some("46 seconds"), Some("1 hour")] {
        sqlx::query("delete from free_scan_engines")
            .execute(&h.owner)
            .await
            .unwrap();
        if let Some(age) = stale {
            beat(&h.owner, "engine-without-sandbox", age).await;
        }
        let (status, _, body) =
            call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{stale:?}: {body}");
        assert_eq!(body["errors"][0]["field"], "scanner");
        assert_eq!(count(&h.owner, "free_scans").await, 0);
        assert_eq!(count(&h.owner, "jobs").await, 0);
    }
    let received = h.turnstile.received_requests().await.unwrap_or_default();
    assert!(
        received.is_empty(),
        "Cloudflare was called {} times",
        received.len()
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_fresh_heartbeat_from_any_one_engine_is_enough(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    // One engine fell silent; another beat 44 seconds ago.
    sqlx::query("delete from free_scan_engines")
        .execute(&h.owner)
        .await
        .unwrap();
    beat(&h.owner, "engine-gone", "10 minutes").await;
    beat(&h.owner, "engine-live", "44 seconds").await;
    let (status, _, body) =
        call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
}

/// Audit M1: behind one shared address (or after the day's budget is spent) a cached result is
/// still served, without a Cloudflare call and without spending anything.
#[sqlx::test(migrations = "../db/migrations")]
async fn a_cached_result_is_served_before_the_budget_and_before_cloudflare(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true).await;
    solved(&h).await;
    let (_, _, first) = call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    finish(
        &h.owner,
        first["id"].as_str().unwrap(),
        "complete",
        "shop.com",
    )
    .await;
    for domain in ["a-shop.com", "b-shop.com"] {
        let (status, _, _) = call(&h.state, post(Some(TOKEN), &ask(domain, "203.0.113.5"))).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    // The address has now used its 3 scans.
    let (status, _, _) = call(
        &h.state,
        post(Some(TOKEN), &ask("c-shop.com", "203.0.113.5")),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let before = h
        .turnstile
        .received_requests()
        .await
        .unwrap_or_default()
        .len();

    let (status, _, again) =
        call(&h.state, post(Some(TOKEN), &ask("shop.com", "203.0.113.5"))).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["cached"], true);
    assert_eq!(again["id"], first["id"]);
    let after = h
        .turnstile
        .received_requests()
        .await
        .unwrap_or_default()
        .len();
    assert_eq!(before, after, "a cache hit called Cloudflare");
}
