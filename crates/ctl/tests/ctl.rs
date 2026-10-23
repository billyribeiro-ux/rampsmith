//! `ctl`'s token refresh job and leadership, against PostgreSQL and a mock Shopify.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::time::Duration as StdDuration;

use contracts::ShopifyTokenRefresh;
use crypto::KeyRing;
use ctl::leader;
use ctl::rewrap::{Report, Rewrap};
use ctl::token_refresh::TokenRefresh;
use db::Db;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use queue::{ClaimedJob, Failure, Lease, WorkerConfig};
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::{RefreshOutcome, ShopSession, ShopifyAuth};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use time::{Duration, OffsetDateTime};
use wiremock::matchers::method;
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

mod support;

use support::worker_login_pool;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_ctl_test";

struct Field(&'static str, &'static str);

impl Match for Field {
    fn matches(&self, request: &Request) -> bool {
        let form: HashMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        form.get(self.0).map(String::as_str) == Some(self.1)
    }
}

fn body(n: u32) -> serde_json::Value {
    json!({
        "access_token": format!("shpat_{n}"),
        "scope": "read_products",
        "expires_in": 3600,
        "refresh_token": format!("shprt_{n}"),
        "refresh_token_expires_in": 7_776_000
    })
}

async fn worker_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    worker_login_pool(opts, conn).await
}

struct World {
    pool: PgPool,
    owner: PgPool,
    shopify: MockServer,
    handler: TokenRefresh,
    session: ShopSession,
}

/// A shop installed at `now()` through token exchange, run as the worker role.
async fn world(opts: PgPoolOptions, conn: PgConnectOptions) -> World {
    world_at(opts, conn, now()).await
}

/// A shop installed at `at` through token exchange, run as the worker role.
async fn world_at(opts: PgPoolOptions, conn: PgConnectOptions, at: OffsetDateTime) -> World {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = worker_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .and(Field(
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(body(1)))
        .mount(&shopify)
        .await;
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse("k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            StdDuration::from_secs(2),
        )
        .unwrap(),
    );
    let t = at.unix_timestamp();
    let token = encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": "https://demo.myshopify.com/admin", "dest": "https://demo.myshopify.com",
                "aud": CLIENT_ID, "sub": "1", "exp": t + 60, "nbf": t - 1}),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let session = auth.authenticate_at(&token, at).await.unwrap();
    World {
        pool,
        owner,
        shopify,
        handler: TokenRefresh::new(db, auth),
        session,
    }
}

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_792_300_000).unwrap()
}

fn job(w: &World, payload: serde_json::Value, schema: &str) -> ClaimedJob {
    ClaimedJob {
        lease: Lease {
            job_id: uuid::Uuid::now_v7(),
            worker: "test".to_owned(),
            attempt: 1,
        },
        queue: ShopifyTokenRefresh::QUEUE.to_owned(),
        payload_schema: schema.to_owned(),
        payload,
        tenant_id: Some(w.session.tenant.as_uuid()),
        max_attempts: 8,
        locked_until: OffsetDateTime::now_utc() + Duration::seconds(30),
        traceparent: None,
    }
}

fn refresh_job(w: &World) -> ClaimedJob {
    job(
        w,
        json!({"shop_id": w.session.shop_id.as_uuid().to_string()}),
        ShopifyTokenRefresh::SCHEMA,
    )
}

async fn keepalive_runs(w: &World) -> Vec<OffsetDateTime> {
    sqlx::query_scalar(
        "select run_at from jobs where queue = 'shopify.token_refresh' order by run_at",
    )
    .fetch_all(&w.owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_due_token_is_refreshed_and_the_next_keepalive_scheduled(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token"))
        .and(Field("refresh_token", "shprt_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body(2)))
        .expect(1)
        .mount(&w.shopify)
        .await;
    let at = now() + Duration::days(7);
    let outcome = w.handler.handle_at(&refresh_job(&w), at).await.unwrap();
    assert_eq!(outcome, RefreshOutcome::Refreshed);
    assert_eq!(
        keepalive_runs(&w).await,
        [now() + Duration::days(7), at + Duration::days(7)]
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_fresh_token_only_schedules_the_next_keepalive(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let at = now() + Duration::minutes(5);
    let outcome = w.handler.handle_at(&refresh_job(&w), at).await.unwrap();
    assert_eq!(outcome, RefreshOutcome::Fresh);
    // The install already scheduled a run in the same ISO week; nothing is duplicated.
    assert_eq!(keepalive_runs(&w).await, [now() + Duration::days(7)]);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_revoked_grant_ends_the_keepalive_chain(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&w.shopify)
        .await;
    let at = now() + Duration::days(7);
    let outcome = w.handler.handle_at(&refresh_job(&w), at).await.unwrap();
    assert_eq!(outcome, RefreshOutcome::Revoked);
    assert_eq!(keepalive_runs(&w).await.len(), 1, "no new keep-alive");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shopify_outages_retry_and_rejections_do_not(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let at = now() + Duration::days(7);
    let outage = Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token"))
        .respond_with(ResponseTemplate::new(503))
        .mount_as_scoped(&w.shopify)
        .await;
    match w.handler.handle_at(&refresh_job(&w), at).await.unwrap_err() {
        Failure::Retryable(e) => assert_eq!(e.code, "shopify_unavailable"),
        Failure::Permanent(other) => panic!("{other:?}"),
    }
    drop(outage);
    Mock::given(method("POST"))
        .and(Field("grant_type", "refresh_token"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&w.shopify)
        .await;
    match w.handler.handle_at(&refresh_job(&w), at).await.unwrap_err() {
        Failure::Permanent(e) => assert_eq!(e.code, "shopify_rejected"),
        Failure::Retryable(other) => panic!("{other:?}"),
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn malformed_jobs_fail_permanently(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let cases = [
        (
            job(&w, json!({"shop_id": "nope"}), ShopifyTokenRefresh::SCHEMA),
            "payload_invalid",
        ),
        (
            job(&w, json!({}), ShopifyTokenRefresh::SCHEMA),
            "payload_invalid",
        ),
        (
            refresh_job(&w).clone_with_schema("shopify.token_refresh@2"),
            "payload_schema_unknown",
        ),
        (
            ClaimedJob {
                tenant_id: None,
                ..refresh_job(&w)
            },
            "tenant_missing",
        ),
    ];
    for (job, code) in cases {
        match w.handler.handle_at(&job, now()).await.unwrap_err() {
            Failure::Permanent(e) => assert_eq!(e.code, code),
            Failure::Retryable(other) => panic!("{code}: {other:?}"),
        }
    }
}

trait WithSchema {
    fn clone_with_schema(self, schema: &str) -> Self;
}

impl WithSchema for ClaimedJob {
    fn clone_with_schema(mut self, schema: &str) -> Self {
        schema.clone_into(&mut self.payload_schema);
        self
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_worker_runs_due_keepalive_jobs_end_to_end(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    // The real worker reads the wall clock, so the shop is installed at the wall clock too:
    // with the fixed `now()`, the stored access token went stale an hour after that instant
    // and the job took the refresh path this test does not mock.
    let w = world_at(opts, conn, OffsetDateTime::now_utc()).await;
    // Make the installed keep-alive due now.
    sqlx::query("update jobs set run_at = now() - interval '1 second'")
        .execute(&w.owner)
        .await
        .unwrap();
    let handler = w.handler.clone();
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let mut config = WorkerConfig::new(ShopifyTokenRefresh::QUEUE, "ctl-test");
    config.poll_interval = StdDuration::from_millis(100);
    let worker = tokio::spawn(queue::run(
        w.pool.clone(),
        config,
        move |job| {
            let handler = handler.clone();
            async move { handler.handle(job).await }
        },
        async move {
            let _ = stopped.wait_for(|s| *s).await;
        },
    ));
    let mut done = 0_i64;
    for _ in 0..50 {
        done = sqlx::query_scalar("select count(*) from jobs where state = 'succeeded'")
            .fetch_one(&w.owner)
            .await
            .unwrap();
        if done == 1 {
            break;
        }
        tokio::time::sleep(StdDuration::from_millis(100)).await;
    }
    stop.send(true).unwrap();
    worker.await.unwrap().unwrap();
    assert_eq!(done, 1, "the keep-alive job did not succeed");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn only_one_instance_leads_at_a_time(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    let first = leader::try_acquire(&pool).await.unwrap();
    assert!(first.is_some());
    assert!(leader::try_acquire(&pool).await.unwrap().is_none());
    // Session-level locks die with their connection.
    sqlx::Connection::close(first.unwrap().detach())
        .await
        .unwrap();
    assert!(leader::try_acquire(&pool).await.unwrap().is_some());
}

// --- A leader connection that fails its check is abandoned (audit L12, ADR-047) ----------------

/// Waits up to five seconds for `pool` to win the leader lock: the server frees a closed
/// session's locks a moment after the client hangs up.
async fn takes_over(pool: &PgPool) -> bool {
    for _ in 0..100 {
        if leader::try_acquire(pool).await.unwrap().is_some() {
            return true;
        }
        tokio::time::sleep(StdDuration::from_millis(50)).await;
    }
    false
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_failed_liveness_check_closes_the_leader_connection_and_frees_the_lock(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    // Two pools stand for two ctl instances: a pool hands its own idle connection back to the
    // same caller, and the lock is re-entrant within one session.
    let first = worker_pool(opts.clone(), conn.clone()).await;
    let second = worker_pool(opts, conn).await;

    let mut leader_conn = leader::try_acquire(&first).await.unwrap().unwrap();
    // The session stays up and keeps the lock, but every statement on it now fails: the
    // transaction is aborted, which is how a failed query leaves a real connection.
    sqlx::query("begin")
        .execute(&mut *leader_conn)
        .await
        .unwrap();
    assert!(
        sqlx::query("select 1 / 0")
            .execute(&mut *leader_conn)
            .await
            .is_err()
    );
    assert!(
        leader::try_acquire(&second).await.unwrap().is_none(),
        "the poisoned session still holds the lock"
    );

    assert!(leader::keep_or_drop(leader_conn).await.is_none());

    assert!(
        takes_over(&second).await,
        "the lock stayed with a connection the old leader no longer watched"
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_healthy_leader_connection_keeps_its_lock(opts: PgPoolOptions, conn: PgConnectOptions) {
    let first = worker_pool(opts.clone(), conn.clone()).await;
    let second = worker_pool(opts, conn).await;
    let leader_conn = leader::try_acquire(&first).await.unwrap().unwrap();

    let leader_conn = leader::keep_or_drop(leader_conn).await;
    assert!(leader_conn.is_some());
    assert!(
        leader::try_acquire(&second).await.unwrap().is_none(),
        "a connection that answers is still the leader"
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_leader_reaps_expired_leases_and_keeps_partitions_ahead(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = worker_pool(opts, conn).await;
    sqlx::query(
        "insert into jobs (id, queue, payload_schema, payload, state, attempts, locked_by, locked_until)
         values ($1, 'system.test', 'system.test@1', '{}', 'running', 1, 'gone', now() - interval '1 minute')",
    )
    .bind(uuid::Uuid::now_v7())
    .execute(&owner)
    .await
    .unwrap();
    assert_eq!(leader::duties(&pool, true).await.unwrap(), 1);
    let state: String = sqlx::query_scalar("select state from jobs")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(state, "ready");
    let partitions: i64 = sqlx::query_scalar(
        "select count(*) from pg_inherits where inhparent = 'finding_occurrences'::regclass",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!(partitions >= 4, "{partitions}");
}

// --- Sweeping expired sign-in state (audit M6, ADR-042) ---------------------------------------

/// A user with an expired session, an expired ceremony and a live ceremony.
async fn seed_sign_in_state(owner: &PgPool) {
    for statement in [
        "insert into users (id, email, display_name)
         values ('00000000-0000-7000-8000-000000000001', 'ada@example.com', 'Ada')",
        "insert into web_sessions (token_hash, user_id, idle_expires_at, absolute_expires_at)
         values (decode(repeat('ab', 32), 'hex'), '00000000-0000-7000-8000-000000000001',
                 now() - interval '1 hour', now() + interval '1 day')",
        "insert into webauthn_ceremonies (id, kind, state, expires_at)
         values ('00000000-0000-7000-8000-0000000000e1', 'authentication', '{}',
                 now() - interval '1 minute')",
        "insert into webauthn_ceremonies (id, kind, state, expires_at)
         values ('00000000-0000-7000-8000-0000000000e2', 'authentication', '{}',
                 now() + interval '5 minutes')",
    ] {
        sqlx::query(statement).execute(owner).await.unwrap();
    }
}

async fn count(owner: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_sweep_removes_only_expired_sign_in_state(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let db = Db::from_pool(worker_pool(opts, conn).await);
    seed_sign_in_state(&owner).await;

    assert_eq!(leader::sweep_identity(&db).await.unwrap(), 2);
    assert_eq!(count(&owner, "web_sessions").await, 0);
    assert_eq!(count(&owner, "webauthn_ceremonies").await, 1);
    assert_eq!(count(&owner, "users").await, 1, "accounts are never swept");
    assert_eq!(leader::sweep_identity(&db).await.unwrap(), 0);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_retention_sweep_removes_old_store_data_and_ends_and_deletes_free_scans(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let db = Db::from_pool(worker_pool(opts, conn).await);
    for statement in [
        "insert into tenants (id, kind) values ('00000000-0000-7000-8000-0000000000a1', 'shopify_store')",
        "insert into sites (id, tenant_id, platform, base_url)
         values ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000000a1',
                 'shopify', 'https://demo.example/')",
        "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
         values ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a1',
                 '00000000-0000-7000-8000-0000000000a2', 'manual', 'queued', 'axe-core', 0)",
        "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload, created_at)
         values ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000a1',
                 '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2',
                 'products', 0, '{}', now() - interval '31 days'),
                ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000a1',
                 '00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2',
                 'products', 1, '{}', now() - interval '1 day')",
        "insert into free_scans (id, domain, origin, ip_hash, status, created_at)
         values ('00000000-0000-7000-8000-0000000000c1', 'stuck.example.com',
                 'https://stuck.example.com/', '\\x0101010101010101010101010101010101010101010101010101010101010101',
                 'running', now() - interval '11 minutes')",
        "insert into free_scans (id, domain, origin, ip_hash, status, created_at, expires_at)
         values ('00000000-0000-7000-8000-0000000000c2', 'old.example.com',
                 'https://old.example.com/', '\\x0202020202020202020202020202020202020202020202020202020202020202',
                 'queued', now() - interval '25 hours', now() - interval '1 hour')",
    ] {
        sqlx::query(statement).execute(&owner).await.unwrap();
    }

    assert_eq!(leader::sweep_retention(&db).await.unwrap(), (1, 1));
    assert_eq!(count(&owner, "scan_inputs").await, 1);
    assert_eq!(count(&owner, "free_scans").await, 1);
    let status: String = sqlx::query_scalar("select status from free_scans")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        status, "failed",
        "a scan the engine never finished is ended"
    );
    assert_eq!(leader::sweep_retention(&db).await.unwrap(), (0, 0));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_leader_sweeps_on_its_own_cadence(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = worker_pool(opts, conn).await;
    seed_sign_in_state(&owner).await;

    let (stop, stopped) = tokio::sync::watch::channel(false);
    let cadence = leader::Cadence {
        reap_every: StdDuration::from_millis(50),
        partitions_every: StdDuration::from_hours(1),
        sweep_every: StdDuration::from_millis(100),
        webhook_sweep_every: StdDuration::from_hours(1),
        retry_every: StdDuration::from_millis(50),
    };
    let leading = tokio::spawn(leader::run(pool, cadence, async move {
        let mut stopped = stopped;
        let _ = stopped.wait_for(|stop| *stop).await;
    }));
    let mut left = i64::MAX;
    for _ in 0..50 {
        left = count(&owner, "web_sessions").await + count(&owner, "webauthn_ceremonies").await;
        if left == 1 {
            break;
        }
        tokio::time::sleep(StdDuration::from_millis(100)).await;
    }
    stop.send(true).unwrap();
    leading.await.unwrap();
    assert_eq!(
        left, 1,
        "the expired rows went and the live ceremony stayed"
    );
}

// --- Re-wrapping stored tokens under a new master key (audit L6, ADR-045) -----------------------

const K1: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // 0..=31, unpadded base64
const K2: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"; // 32..=63

/// Where the value's own nonce and ciphertext begin in a sealed value: after the version byte,
/// the wrap nonce (12) and the wrapped data key (32 and a 16-byte tag). Re-wrapping rewrites
/// only what comes before.
const VALUE_AT: usize = 1 + 12 + 48;

struct Fleet {
    owner: PgPool,
    db: Db,
    _shopify: MockServer,
}

/// `shops` shops, each in a tenant of its own, installed through token exchange under key k1,
/// the way production stored them; `db` is the worker role's.
async fn fleet(opts: PgPoolOptions, conn: PgConnectOptions, shops: usize) -> Fleet {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let db = Db::from_pool(worker_pool(opts, conn).await);
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .and(Field(
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(body(1)))
        .mount(&shopify)
        .await;
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse(&format!("k1:{K1}")).unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            StdDuration::from_secs(2),
        )
        .unwrap(),
    );
    let at = now();
    let t = at.unix_timestamp();
    for i in 0..shops {
        let domain = format!("fleet-{i}.myshopify.com");
        let token = encode(
            &Header::new(Algorithm::HS256),
            &json!({"iss": format!("https://{domain}/admin"), "dest": format!("https://{domain}"),
                    "aud": CLIENT_ID, "sub": "1", "exp": t + 60, "nbf": t - 1}),
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        auth.authenticate_at(&token, at).await.unwrap();
    }
    Fleet {
        owner,
        db,
        _shopify: shopify,
    }
}

/// A stored token row, as the database holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    shop: uuid::Uuid,
    key_id: String,
    version: i64,
    access_ct: Vec<u8>,
    refresh_ct: Vec<u8>,
}

async fn token_rows(owner: &PgPool) -> Vec<Row> {
    use sqlx::Row as _;
    sqlx::query(
        "select shop_id, key_id, version, access_ct, refresh_ct from shopify_tokens order by shop_id",
    )
    .fetch_all(owner)
    .await
    .unwrap()
    .iter()
    .map(|row| Row {
        shop: row.get("shop_id"),
        key_id: row.get("key_id"),
        version: row.get("version"),
        access_ct: row.get("access_ct"),
        refresh_ct: row.get("refresh_ct"),
    })
    .collect()
}

fn rotated_ring() -> KeyRing {
    KeyRing::parse(&format!("k2:{K2},k1:{K1}")).unwrap()
}

fn key_count(key_id: &str, tokens: i64) -> db::KeyCount {
    db::KeyCount {
        key_id: key_id.to_owned(),
        tokens,
    }
}

/// Opens both tokens of `row` with a ring that holds k2 only, using the contexts the
/// token lifecycle seals them with.
fn assert_opens_as_k2(row: &Row) {
    let only_new = KeyRing::parse(&format!("k2:{K2}")).unwrap();
    let shop = domain::ShopId::from_uuid(row.shop);
    let access = only_new
        .open_string(
            "k2",
            &row.access_ct,
            shopify_auth::access_context(shop).as_bytes(),
        )
        .unwrap();
    let refresh = only_new
        .open_string(
            "k2",
            &row.refresh_ct,
            shopify_auth::refresh_context(shop).as_bytes(),
        )
        .unwrap();
    assert_eq!(access.expose_secret(), "shpat_1");
    assert_eq!(refresh.expose_secret(), "shprt_1");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_rewrap_pass_moves_every_token_to_the_new_key_and_changes_nothing_else(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let fleet = fleet(opts, conn, 5).await;
    let before = token_rows(&fleet.owner).await;
    assert_eq!(before.len(), 5);
    assert!(before.iter().all(|r| r.key_id == "k1"));

    // Rotation: the new key goes first and the old one stays until nothing uses it. Batches of
    // two take three round trips.
    let job = Rewrap::new(fleet.db.clone(), rotated_ring()).with_batch(2);
    assert_eq!(job.remaining().await.unwrap(), vec![key_count("k1", 5)]);
    let report = job.run().await.unwrap();
    assert_eq!(
        report,
        Report {
            examined: 5,
            rewrapped: 5,
            skipped: 0,
            failed: 0
        }
    );

    let after = token_rows(&fleet.owner).await;
    assert_eq!(after.len(), 5);
    for (was, is) in before.iter().zip(&after) {
        assert_eq!(was.shop, is.shop);
        assert_eq!(is.key_id, "k2");
        assert_eq!(was.version, is.version, "re-wrapping is not a new version");
        assert_ne!(was.access_ct, is.access_ct);
        assert_ne!(was.refresh_ct, is.refresh_ct);
        // The value's own ciphertext is carried over byte for byte.
        assert_eq!(was.access_ct[VALUE_AT..], is.access_ct[VALUE_AT..]);
        assert_eq!(was.refresh_ct[VALUE_AT..], is.refresh_ct[VALUE_AT..]);
        // With the old key gone from the ring, both tokens still open, bound to their shop.
        assert_opens_as_k2(is);
    }
    assert_eq!(job.remaining().await.unwrap(), vec![key_count("k2", 5)]);

    // A second pass finds nothing and writes nothing.
    assert_eq!(job.run().await.unwrap(), Report::default());
    assert_eq!(token_rows(&fleet.owner).await, after);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn passes_running_at_once_re_wrap_each_row_exactly_once(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let fleet = fleet(opts, conn, 6).await;
    let one = Rewrap::new(fleet.db.clone(), rotated_ring()).with_batch(2);
    let two = Rewrap::new(fleet.db.clone(), rotated_ring()).with_batch(3);

    let (first, second) = tokio::join!(one.run(), two.run());
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(
        first.rewrapped + second.rewrapped,
        6,
        "{first:?} {second:?}"
    );
    assert_eq!(first.failed + second.failed, 0);
    for row in token_rows(&fleet.owner).await {
        assert_eq!((row.key_id.as_str(), row.version), ("k2", 0));
        assert_opens_as_k2(&row);
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn rows_that_cannot_be_rewrapped_are_reported_and_left_where_they_are(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let fleet = fleet(opts, conn, 4).await;
    let rows = token_rows(&fleet.owner).await;
    // One row names a key the ring does not hold; another has a damaged ciphertext.
    sqlx::query("update shopify_tokens set key_id = 'k0' where shop_id = $1")
        .bind(rows[0].shop)
        .execute(&fleet.owner)
        .await
        .unwrap();
    sqlx::query(
        "update shopify_tokens
            set access_ct = set_byte(access_ct, length(access_ct) - 1,
                                     get_byte(access_ct, length(access_ct) - 1) # 1)
          where shop_id = $1",
    )
    .bind(rows[1].shop)
    .execute(&fleet.owner)
    .await
    .unwrap();
    let damaged = token_rows(&fleet.owner).await;

    let job = Rewrap::new(fleet.db.clone(), rotated_ring()).with_batch(1);
    let report = job.run().await.unwrap();
    assert_eq!(
        report,
        Report {
            examined: 4,
            rewrapped: 2,
            skipped: 0,
            failed: 2
        }
    );
    // The two failures are untouched and still counted under their old keys, which therefore
    // cannot be removed yet.
    let after = token_rows(&fleet.owner).await;
    assert_eq!(after[..2], damaged[..2]);
    assert!(after[2..].iter().all(|r| r.key_id == "k2"));
    assert_eq!(
        job.remaining().await.unwrap(),
        vec![key_count("k0", 1), key_count("k1", 1), key_count("k2", 2)]
    );

    // A later pass tries just those two again.
    let again = job.run().await.unwrap();
    assert_eq!(
        again,
        Report {
            examined: 2,
            rewrapped: 0,
            skipped: 0,
            failed: 2
        }
    );
}

// --- The runtime role guard (audit M4, ADR-040) ----------------------------------------------

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn startup_accepts_a_login_member_of_rampsmith_worker(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(worker_pool(opts, conn).await);
    let verified = ctl::startup::require_worker_role(
        &db,
        StdDuration::from_millis(10),
        std::future::pending::<()>(),
    )
    .await
    .unwrap();
    assert!(verified);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn startup_refuses_a_superuser_at_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = Db::from_pool(opts.connect_with(conn).await.unwrap());
    let error = ctl::startup::require_worker_role(
        &db,
        StdDuration::from_mins(1),
        std::future::pending::<()>(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, db::RoleError::Refused { .. }), "{error:?}");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn startup_refuses_a_superuser_that_switched_to_the_worker_role(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = opts
        .after_connect(|c, _| {
            Box::pin(async move {
                sqlx::Executor::execute(c, "set role rampsmith_worker").await?;
                Ok(())
            })
        })
        .connect_with(conn)
        .await
        .unwrap();
    let error = ctl::startup::require_worker_role(
        &Db::from_pool(pool),
        StdDuration::from_mins(1),
        std::future::pending::<()>(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, db::RoleError::Refused { .. }), "{error:?}");
}

#[tokio::test]
async fn startup_waits_for_an_unreachable_database_and_stops_on_shutdown() {
    let pool = PgPoolOptions::new()
        .acquire_timeout(StdDuration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:9/none")
        .unwrap();
    let verified = ctl::startup::require_worker_role(
        &Db::from_pool(pool),
        StdDuration::from_millis(20),
        tokio::time::sleep(StdDuration::from_millis(300)),
    )
    .await
    .unwrap();
    assert!(!verified, "shutdown must end the wait without a verdict");
}
