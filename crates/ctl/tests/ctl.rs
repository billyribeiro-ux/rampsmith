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
use ctl::token_refresh::TokenRefresh;
use db::Db;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use queue::{ClaimedJob, Failure, Lease, WorkerConfig};
use secrecy::SecretString;
use serde_json::json;
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::{RefreshOutcome, ShopSession, ShopifyAuth};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};
use time::{Duration, OffsetDateTime};
use wiremock::matchers::method;
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

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
    opts.max_connections(8)
        .after_connect(|c, _| {
            Box::pin(async move {
                c.execute("set role rampsmith_worker").await?;
                Ok(())
            })
        })
        .connect_with(conn)
        .await
        .unwrap()
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
    let t = now().unix_timestamp();
    let token = encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": "https://demo.myshopify.com/admin", "dest": "https://demo.myshopify.com",
                "aud": CLIENT_ID, "sub": "1", "exp": t + 60, "nbf": t - 1}),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let session = auth.authenticate_at(&token, now()).await.unwrap();
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
    let w = world(opts, conn).await;
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
