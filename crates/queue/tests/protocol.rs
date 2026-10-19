//! The five operations of PLAN §10 against a real PostgreSQL 18, plus the reaper.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::collections::HashSet;
use std::time::Duration;

use contracts::JobError;
use queue::{Enqueued, FailOutcome, Failure, NewJob, QueueError};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgListener, PgPoolOptions};
use support::{app_pool, assert_empty, expire_leases, owner_pool, tenant, worker_pool};

const LEASE: Duration = Duration::from_secs(30);

fn job(key: &str) -> NewJob {
    NewJob::new("test.effect", "test.effect@1", json!({ "key": key }))
}

async fn enqueue(pool: &PgPool, new: &NewJob) -> Enqueued {
    let mut conn = pool.acquire().await.unwrap();
    queue::enqueue(&mut conn, new).await.unwrap()
}

fn error(code: &str) -> JobError {
    JobError {
        code: code.to_owned(),
        message: "boom".to_owned(),
        retryable: true,
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_claimed_job_carries_a_lease_and_its_payload(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts, conn).await;
    let Enqueued::Created(id) = enqueue(&pool, &job("a")).await else {
        panic!("duplicate")
    };
    let claimed = queue::claim(&pool, "test.effect", 10, "w1", LEASE)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    let j = &claimed[0];
    assert_eq!(j.lease.job_id, id);
    assert_eq!(j.lease.worker, "w1");
    assert_eq!(j.lease.attempt, 1);
    assert_eq!(j.payload, json!({ "key": "a" }));
    assert_eq!(j.payload_schema, "test.effect@1");
    assert_empty(
        &queue::claim(&pool, "test.effect", 10, "w2", LEASE)
            .await
            .unwrap(),
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_idempotency_key_enqueues_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    let first = enqueue(&pool, &job("a").idempotency_key("fix-123")).await;
    let second = enqueue(&pool, &job("b").idempotency_key("fix-123")).await;
    assert!(matches!(first, Enqueued::Created(_)));
    assert_eq!(second, Enqueued::Duplicate);
    assert_eq!(
        queue::claim(&pool, "test.effect", 10, "w", LEASE)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn concurrent_workers_never_claim_the_same_job(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts.max_connections(10), conn).await;
    for i in 0..60 {
        enqueue(&pool, &job(&format!("k{i}"))).await;
    }
    let mut handles = Vec::new();
    for w in 0..6 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            let mut mine = Vec::new();
            loop {
                let batch = queue::claim(&pool, "test.effect", 3, &format!("w{w}"), LEASE)
                    .await
                    .unwrap();
                if batch.is_empty() {
                    return mine;
                }
                mine.extend(batch.into_iter().map(|j| j.lease.job_id));
            }
        }));
    }
    let mut all = Vec::new();
    for h in handles {
        all.extend(h.await.unwrap());
    }
    let unique: HashSet<_> = all.iter().collect();
    assert_eq!(all.len(), 60);
    assert_eq!(unique.len(), 60, "a job was claimed twice");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn claims_follow_priority_then_run_at_and_skip_future_jobs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts, conn).await;
    let later = time::OffsetDateTime::now_utc() + time::Duration::hours(1);
    enqueue(&pool, &job("future").run_at(later)).await;
    enqueue(&pool, &job("normal")).await;
    enqueue(&pool, &job("urgent").priority(10)).await;
    let claimed = queue::claim(&pool, "test.effect", 10, "w", LEASE)
        .await
        .unwrap();
    let keys: Vec<_> = claimed
        .iter()
        .map(|j| j.payload["key"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(keys, vec!["urgent", "normal"]);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn claims_are_per_queue(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    enqueue(&pool, &NewJob::new("scan.page", "scan.page@1", json!({}))).await;
    assert_empty(
        &queue::claim(&pool, "test.effect", 10, "w", LEASE)
            .await
            .unwrap(),
    );
    assert_eq!(
        queue::claim(&pool, "scan.page", 10, "w", LEASE)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_heartbeat_extends_only_a_lease_still_held(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    enqueue(&pool, &job("a")).await;
    let j = queue::claim(&pool, "test.effect", 1, "w1", Duration::from_secs(5))
        .await
        .unwrap()
        .remove(0);
    let before = j.locked_until;
    assert!(
        queue::heartbeat(&pool, &j.lease, Duration::from_mins(1))
            .await
            .unwrap()
    );
    let after: time::OffsetDateTime =
        sqlx::query_scalar("select locked_until from jobs where id = $1")
            .bind(j.lease.job_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(after > before + time::Duration::seconds(30));

    expire_leases(&owner).await;
    assert_eq!(queue::reap_expired(&pool).await.unwrap(), 1);
    assert!(
        !queue::heartbeat(&pool, &j.lease, LEASE).await.unwrap(),
        "heartbeat after losing the lease"
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_attempt_number_fences_a_worker_that_lost_its_lease(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    enqueue(&pool, &job("a")).await;
    let first = queue::claim(&pool, "test.effect", 1, "w1", LEASE)
        .await
        .unwrap()
        .remove(0);
    expire_leases(&owner).await;
    queue::reap_expired(&pool).await.unwrap();
    let second = queue::claim(&pool, "test.effect", 1, "w2", LEASE)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(second.lease.attempt, 2);

    assert!(matches!(
        queue::complete(&pool, &first.lease).await,
        Err(QueueError::LeaseLost)
    ));
    assert!(matches!(
        queue::fail(&pool, &first.lease, &Failure::Permanent(error("late")), 0.5).await,
        Err(QueueError::LeaseLost)
    ));
    queue::complete(&pool, &second.lease).await.unwrap();

    let (state, attempts): (String, i32) =
        sqlx::query_as("select state, attempts from jobs where id = $1")
            .bind(second.lease.job_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!((state.as_str(), attempts), ("succeeded", 2));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_retryable_failure_backs_off_and_exhaustion_is_dead(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    enqueue(&pool, &job("a").max_attempts(2)).await;

    let j = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    let outcome = queue::fail(
        &pool,
        &j.lease,
        &Failure::Retryable(error("shopify_throttled")),
        0.5,
    )
    .await
    .unwrap();
    let FailOutcome::Retrying { run_at } = outcome else {
        panic!("{outcome:?}")
    };
    let wait = run_at - time::OffsetDateTime::now_utc();
    assert!(
        wait > time::Duration::seconds(3) && wait < time::Duration::seconds(4),
        "{wait}"
    );
    assert!(
        queue::claim(&pool, "test.effect", 1, "w", LEASE)
            .await
            .unwrap()
            .is_empty(),
        "still backing off"
    );

    sqlx::query("update jobs set run_at = now()")
        .execute(&owner)
        .await
        .unwrap();
    let j = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(j.lease.attempt, 2);
    let outcome = queue::fail(
        &pool,
        &j.lease,
        &Failure::Retryable(error("shopify_throttled")),
        0.5,
    )
    .await
    .unwrap();
    assert_eq!(outcome, FailOutcome::Dead);

    let (state, last_error): (String, serde_json::Value) =
        sqlx::query_as("select state, last_error from jobs")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(state, "dead");
    assert_eq!(
        last_error,
        json!({"code": "shopify_throttled", "message": "boom", "retryable": false})
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_permanent_failure_is_dead_at_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    enqueue(&pool, &job("a")).await;
    let j = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    let outcome = queue::fail(
        &pool,
        &j.lease,
        &Failure::Permanent(error("payload_invalid")),
        0.5,
    )
    .await
    .unwrap();
    assert_eq!(outcome, FailOutcome::Dead);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_reaper_returns_expired_jobs_and_buries_exhausted_ones(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    enqueue(&pool, &job("retry")).await;
    enqueue(&pool, &job("last").max_attempts(1)).await;
    queue::claim(&pool, "test.effect", 10, "w", LEASE)
        .await
        .unwrap();
    expire_leases(&owner).await;
    assert_eq!(queue::reap_expired(&pool).await.unwrap(), 2);

    let rows: Vec<(String, String, serde_json::Value)> = sqlx::query_as(
        "select payload->>'key', state, last_error from jobs order by payload->>'key'",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(rows[0].0, "last");
    assert_eq!(rows[0].1, "dead");
    assert_eq!(rows[1].1, "ready");
    assert_eq!(rows[1].2["code"], "lease_expired");
    assert_eq!(rows[1].2["retryable"], true);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_live_lease_is_never_reaped(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    enqueue(&pool, &job("a")).await;
    queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap();
    assert_eq!(queue::reap_expired(&pool).await.unwrap(), 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_dead_job_is_retried_only_on_request(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    let Enqueued::Created(id) = enqueue(&pool, &job("a")).await else {
        panic!()
    };
    let j = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    queue::fail(&pool, &j.lease, &Failure::Permanent(error("x")), 0.0)
        .await
        .unwrap();
    assert_empty(
        &queue::claim(&pool, "test.effect", 1, "w", LEASE)
            .await
            .unwrap(),
    );
    assert!(queue::retry_dead(&pool, id).await.unwrap());
    assert!(
        !queue::retry_dead(&pool, id).await.unwrap(),
        "only dead jobs can be retried"
    );
    let again = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(again.lease.attempt, 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_tenants_ready_jobs_can_be_cancelled(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let a = tenant(&owner).await;
    let b = tenant(&owner).await;
    enqueue(&pool, &job("a").for_tenant(a)).await;
    enqueue(&pool, &job("b").for_tenant(b)).await;
    assert_eq!(queue::cancel_tenant_jobs(&pool, a).await.unwrap(), 1);
    let claimed = queue::claim(&pool, "test.effect", 10, "w", LEASE)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].tenant_id, Some(b));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn enqueue_notifies_listening_workers_on_commit(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = worker_pool(opts, conn).await;
    let mut listener = PgListener::connect_with(&pool).await.unwrap();
    listener.listen(queue::CHANNEL).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    queue::enqueue(&mut tx, &job("a")).await.unwrap();
    let early = tokio::time::timeout(Duration::from_millis(200), listener.recv()).await;
    assert!(early.is_err(), "notified before commit");
    tx.commit().await.unwrap();
    let note = tokio::time::timeout(Duration::from_secs(5), listener.recv())
        .await
        .expect("notification")
        .unwrap();
    assert_eq!(note.payload(), "test.effect");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_app_role_enqueues_only_for_its_own_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let a = tenant(&owner).await;
    let b = tenant(&owner).await;
    let mut tx = app.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(a.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    queue::enqueue(&mut tx, &job("mine").for_tenant(a))
        .await
        .unwrap();
    let foreign = queue::enqueue(&mut tx, &job("theirs").for_tenant(b)).await;
    assert!(foreign.is_err(), "enqueued a job for another tenant");
    tx.rollback().await.unwrap();

    let mut tx = app.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(a.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    queue::enqueue(&mut tx, &job("mine").for_tenant(a))
        .await
        .unwrap();
    let claim = queue::claim(&mut *tx, "test.effect", 1, "app", LEASE).await;
    assert!(claim.is_err(), "the app role must not claim jobs");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn depth_reports_waiting_running_and_dead_jobs_by_queue(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    for key in ["a", "b", "c"] {
        enqueue(&pool, &job(key)).await;
    }
    enqueue(&pool, &NewJob::new("scan.page", "scan.page@1", json!({}))).await;
    let j = queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap()
        .remove(0);
    queue::fail(&pool, &j.lease, &Failure::Permanent(error("x")), 0.0)
        .await
        .unwrap();
    queue::claim(&pool, "test.effect", 1, "w", LEASE)
        .await
        .unwrap();
    sqlx::query("update jobs set run_at = now() - interval '90 seconds' where state = 'ready'")
        .execute(&owner)
        .await
        .unwrap();

    let rows = queue::depth(&pool).await.unwrap();
    let get = |q: &str, s: &str| {
        rows.iter()
            .find(|d| d.queue == q && d.state == s)
            .map(|d| d.count)
    };
    assert_eq!(get("test.effect", "ready"), Some(1));
    assert_eq!(get("test.effect", "running"), Some(1));
    assert_eq!(get("test.effect", "dead"), Some(1));
    assert_eq!(get("scan.page", "ready"), Some(1));
    let age = rows
        .iter()
        .find(|d| d.state == "ready")
        .and_then(|d| d.oldest_ready_seconds)
        .unwrap();
    assert!(age >= 89.0, "{age}");
}
