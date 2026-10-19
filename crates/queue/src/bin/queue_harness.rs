//! Test fixture for the kill-mid-job suite (`tests/kill.rs`); not deployed.
//!
//! Runs one worker on the `test.effect` queue as `rampsmith_worker`. Each job writes an
//! idempotent effect row keyed by `payload.key`. On its first attempt a job can hang before
//! or after the effect, so the test can kill this process at either point.
//!
//! Usage: `queue-harness <database-url> <database-name> <worker-id> <lease-ms>`

use std::error::Error;
use std::str::FromStr;
use std::time::Duration;

use contracts::JobError;
use queue::{ClaimedJob, Failure, WorkerConfig};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};

const HANG: Duration = Duration::from_hours(1);

fn arg(args: &[String], i: usize, name: &str) -> Result<String, Box<dyn Error>> {
    args.get(i)
        .cloned()
        .ok_or_else(|| format!("missing argument: {name}").into())
}

async fn handle(pool: PgPool, job: ClaimedJob) -> Result<(), Failure> {
    let bad = |message: &str| {
        Failure::Permanent(JobError {
            code: "harness".to_owned(),
            message: message.to_owned(),
            retryable: false,
        })
    };
    let field = |name: &str| {
        job.payload
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let key = field("key").ok_or_else(|| bad("payload.key missing"))?;
    let mode = field("mode").unwrap_or_else(|| "ok".to_owned());
    let first = job.lease.attempt == 1;
    if first && mode == "hang_before_effect" {
        tokio::time::sleep(HANG).await;
    }
    // The effect table exists only in this test, so the query cannot be checked at build time.
    sqlx::query("insert into queue_test_effects (key, attempt) values ($1, $2) on conflict (key) do nothing")
        .bind(&key)
        .bind(job.lease.attempt)
        .execute(&pool)
        .await
        .map_err(|e| Failure::Retryable(JobError { code: "effect".to_owned(), message: e.to_string(), retryable: true }))?;
    if first && mode == "hang_after_effect" {
        tokio::time::sleep(HANG).await;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    let url = arg(&args, 1, "database-url")?;
    let database = arg(&args, 2, "database-name")?;
    let worker = arg(&args, 3, "worker-id")?;
    let lease_ms: u64 = arg(&args, 4, "lease-ms")?.parse()?;

    let options = PgConnectOptions::from_str(&url)?.database(&database);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|c, _| {
            Box::pin(async move {
                c.execute("set role rampsmith_worker").await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await?;

    let mut config = WorkerConfig::new("test.effect", worker);
    config.lease = Duration::from_millis(lease_ms);
    config.poll_interval = Duration::from_millis(200);
    config.concurrency = 16;
    let effects = pool.clone();
    queue::run(
        pool,
        config,
        move |job| handle(effects.clone(), job),
        std::future::pending(),
    )
    .await?;
    Ok(())
}
