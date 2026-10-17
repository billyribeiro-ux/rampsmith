//! R0 exit criterion (PLAN §5): the queue survives a worker kill mid-job with no lost or
//! duplicated job. A real worker process is killed with SIGKILL while jobs hang before and
//! after their side effect; a second worker finishes them once the reaper returns them.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use queue::NewJob;
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{owner_pool, worker_pool};

const LEASE_MS: u64 = 1500;

/// Kills the worker process if the test fails before it does.
struct Worker(Child);

impl Worker {
    fn spawn(conn: &PgConnectOptions, id: &str) -> Self {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let database = conn.get_database().expect("test database name").to_owned();
        let child = Command::new(env!("CARGO_BIN_EXE_queue-harness"))
            .args([url, database, id.to_owned(), LEASE_MS.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn queue-harness");
        Self(child)
    }

    /// SIGKILL: no shutdown hook, no chance to complete or release anything.
    fn kill(mut self) {
        self.0.kill().expect("kill worker");
        self.0.wait().expect("reap worker");
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn wait_for(owner: &PgPool, what: &str, sql: &'static str) {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        let done: bool = sqlx::query_scalar(sql).fetch_one(owner).await.unwrap();
        if done {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_worker_killed_mid_job_loses_and_duplicates_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let workers = worker_pool(opts, conn.clone()).await;
    sqlx::query("create table queue_test_effects (key text primary key, attempt int not null)")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("grant select, insert on queue_test_effects to rampsmith_worker")
        .execute(&owner)
        .await
        .unwrap();

    let modes = ["ok", "hang_before_effect", "hang_after_effect"];
    let mut conn_w = workers.acquire().await.unwrap();
    for i in 0..15 {
        let mode = modes[i % 3];
        let job = NewJob::new(
            "test.effect",
            "test.effect@1",
            json!({ "key": format!("k{i:02}"), "mode": mode }),
        );
        queue::enqueue(&mut conn_w, &job).await.unwrap();
    }
    drop(conn_w);

    // Worker A finishes the plain jobs and hangs on the rest, five before and five after
    // their effect.
    let a = Worker::spawn(&conn, "worker-a");
    wait_for(
        &owner,
        "worker A to reach every hang point",
        "select (select count(*) from jobs where state = 'succeeded') = 5
            and (select count(*) from jobs where state = 'running' and attempts = 1) = 10
            and (select count(*) from queue_test_effects) = 10",
    )
    .await;
    a.kill();

    // Its leases run out; the reaper (ctl's leader) returns the jobs.
    wait_for(
        &owner,
        "worker A's leases to expire",
        "select bool_and(locked_until < now()) from jobs where state = 'running'",
    )
    .await;
    assert_eq!(queue::reap_expired(&workers).await.unwrap(), 10);

    let b = Worker::spawn(&conn, "worker-b");
    wait_for(
        &owner,
        "every job to succeed",
        "select count(*) = 15 from jobs where state = 'succeeded'",
    )
    .await;
    b.kill();

    // Nothing lost: every job succeeded and every key has its effect.
    let effects: i64 = sqlx::query_scalar("select count(*) from queue_test_effects")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(effects, 15);

    // Nothing duplicated: each effect was written exactly once, by the attempt expected.
    let rows: Vec<(String, String, i32, i32)> = sqlx::query_as(
        "select j.payload->>'key', j.payload->>'mode', j.attempts, e.attempt
           from jobs j join queue_test_effects e on e.key = j.payload->>'key'
          order by 1",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(rows.len(), 15);
    for (key, mode, attempts, effect_attempt) in rows {
        let expected = match mode.as_str() {
            "ok" => (1, 1),
            "hang_before_effect" => (2, 2),
            "hang_after_effect" => (2, 1),
            other => panic!("unexpected mode {other}"),
        };
        assert_eq!((attempts, effect_attempt), expected, "{key} ({mode})");
    }
    let stuck: i64 = sqlx::query_scalar("select count(*) from jobs where state <> 'succeeded'")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(stuck, 0);
}
