//! Leadership (PLAN §10): exactly one `ctl` instance runs the lease reaper and partition
//! maintenance, the one holding a session-level advisory lock on a dedicated connection.
//! Losing the connection loses leadership; another instance takes over on its next try.

use std::time::Duration;

use sqlx::PgPool;
use sqlx::pool::PoolConnection;
use sqlx::postgres::Postgres;
use tokio::time::{Instant, MissedTickBehavior, interval, sleep};
use tracing::{info, warn};

/// The advisory lock key, fixed forever. Other advisory locks use `hashtextextended` keys.
pub const LEADER_KEY: i64 = 0x7261_6d70_6c65_6164; // ASCII "ramplead"

/// How often the leader reaps expired leases and maintains partitions.
#[derive(Debug, Clone, Copy)]
pub struct Cadence {
    /// Between reaper runs.
    pub reap_every: Duration,
    /// Between partition checks.
    pub partitions_every: Duration,
    /// Between attempts to become leader.
    pub retry_every: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            reap_every: Duration::from_secs(10),
            partitions_every: Duration::from_hours(1),
            retry_every: Duration::from_secs(15),
        }
    }
}

/// Tries to take leadership once. `Some(connection)` holds it until dropped.
pub async fn try_acquire(pool: &PgPool) -> Result<Option<PoolConnection<Postgres>>, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let won: bool = sqlx::query_scalar!("select pg_try_advisory_lock($1) as \"won!\"", LEADER_KEY)
        .fetch_one(&mut *conn)
        .await?;
    if won { Ok(Some(conn)) } else { Ok(None) }
}

/// One round of the leader's duties.
pub async fn duties(pool: &PgPool, partitions: bool) -> Result<u64, sqlx::Error> {
    let reaped = queue::reap_expired(pool).await.map_err(|e| match e {
        queue::QueueError::Database(e) => e,
        other => sqlx::Error::Protocol(other.to_string()),
    })?;
    if reaped > 0 {
        info!(reaped, "returned expired leases to the queue");
    }
    if partitions {
        sqlx::query!("select ensure_finding_occurrence_partitions(3)")
            .fetch_one(pool)
            .await?;
    }
    Ok(reaped)
}

/// Competes for leadership and, while leader, performs its duties, until `shutdown`.
pub async fn run(pool: PgPool, cadence: Cadence, shutdown: impl Future<Output = ()>) {
    tokio::pin!(shutdown);
    loop {
        let held = tokio::select! {
            () = &mut shutdown => return,
            held = try_acquire(&pool) => held,
        };
        match held {
            Ok(Some(mut conn)) => {
                info!("became leader");
                let mut tick = interval(cadence.reap_every);
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                let mut partitions_due = Instant::now();
                loop {
                    tokio::select! {
                        () = &mut shutdown => {
                            let _ = sqlx::query!("select pg_advisory_unlock($1)", LEADER_KEY)
                                .fetch_one(&mut *conn)
                                .await;
                            return;
                        }
                        _ = tick.tick() => {}
                    }
                    // A dead leader connection means the lock is gone: stop leading.
                    if let Err(error) = sqlx::query!("select 1 as alive")
                        .fetch_one(&mut *conn)
                        .await
                    {
                        warn!(%error, "lost the leader connection");
                        break;
                    }
                    let partitions = Instant::now() >= partitions_due;
                    match duties(&pool, partitions).await {
                        Ok(_) if partitions => {
                            partitions_due = Instant::now() + cadence.partitions_every;
                        }
                        Ok(_) => {}
                        Err(error) => warn!(%error, "leader duties failed; retrying next tick"),
                    }
                }
            }
            Ok(None) => {}
            Err(error) => warn!(%error, "could not compete for leadership"),
        }
        tokio::select! {
            () = &mut shutdown => return,
            () = sleep(cadence.retry_every) => {}
        }
    }
}
