//! Leadership (PLAN §10): exactly one `ctl` instance runs the lease reaper, partition
//! maintenance and the sweeps of expired sign-in state, store data and free scans, the one holding a session-level
//! advisory lock on a dedicated connection.
//! Losing the connection loses leadership; another instance takes over on its next try.

use std::time::Duration;

use db::{Db, DbError};
use sqlx::pool::PoolConnection;
use sqlx::postgres::Postgres;
use sqlx::{Connection, PgPool};
use tokio::time::{Instant, MissedTickBehavior, interval, sleep, timeout};
use tracing::{info, warn};

/// The advisory lock key, fixed forever. Other advisory locks use `hashtextextended` keys.
pub const LEADER_KEY: i64 = 0x7261_6d70_6c65_6164; // ASCII "ramplead"

/// How often the leader reaps expired leases, maintains partitions and sweeps sign-in state.
#[derive(Debug, Clone, Copy)]
pub struct Cadence {
    /// Between reaper runs.
    pub reap_every: Duration,
    /// Between partition checks.
    pub partitions_every: Duration,
    /// Between sweeps of expired passkey ceremonies and sessions (audit M6, ADR-042).
    pub sweep_every: Duration,
    /// Between attempts to become leader.
    pub retry_every: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            reap_every: Duration::from_secs(10),
            partitions_every: Duration::from_hours(1),
            sweep_every: Duration::from_mins(10),
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

/// How long closing an abandoned leader connection may take before it is simply dropped.
const ABANDON_TIMEOUT: Duration = Duration::from_secs(5);

/// Checks that the leader's connection still answers. `Some(connection)` means it does and
/// leadership continues. After a failed check the connection may still be open, still be
/// holding the advisory lock, and be about to go back into the pool: this instance would then
/// be a leader nobody can see, and no other instance could take over (audit L12). So the
/// connection is detached from the pool and closed, which ends its session and frees the lock
/// at once, and `None` tells the caller to stop leading.
pub async fn keep_or_drop(mut conn: PoolConnection<Postgres>) -> Option<PoolConnection<Postgres>> {
    match sqlx::query!("select 1 as alive")
        .fetch_one(&mut *conn)
        .await
    {
        Ok(_) => Some(conn),
        Err(error) => {
            warn!(%error, "lost the leader connection");
            // Never back to the pool. A broken connection may refuse to close cleanly, or an
            // unresponsive server may never answer the goodbye: dropping the connection
            // closes the socket either way.
            let _ = timeout(ABANDON_TIMEOUT, conn.detach().close()).await;
            None
        }
    }
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

/// Deletes expired passkey ceremonies and sessions; returns how many rows went (audit M6,
/// ADR-042). The worker role may do this and nothing else with identity data.
pub async fn sweep_identity(db: &Db) -> Result<u64, DbError> {
    let mut tx = db.identity().await?;
    let swept = db::repo::identity::sweep(&mut tx).await?;
    tx.commit().await?;
    if swept > 0 {
        info!(swept, "removed expired sign-in state");
    }
    Ok(swept)
}

/// Deletes what expires on its own clock: store data read for scans after 30 days (ADR-035), and
/// free scans after 24 hours, ending the ones the engine never finished first (ADR-265).
/// Returns `(scan inputs, free scans)` deleted.
pub async fn sweep_retention(db: &Db) -> Result<(i64, i64), DbError> {
    let mut tx = db.public().await?;
    let inputs = db::repo::retention::scan_inputs(&mut tx).await?;
    let free = db::repo::retention::free_scans(&mut tx).await?;
    tx.commit().await?;
    if inputs > 0 || free > 0 {
        info!(inputs, free, "removed expired scan data");
    }
    Ok((inputs, free))
}

/// Competes for leadership and, while leader, performs its duties, until `shutdown`.
pub async fn run(pool: PgPool, cadence: Cadence, shutdown: impl Future<Output = ()>) {
    tokio::pin!(shutdown);
    let db = Db::from_pool(pool.clone());
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
                let mut sweep_due = Instant::now();
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
                    // A leader connection that stops answering is abandoned, not pooled, so
                    // the lock goes with it (audit L12, ADR-047).
                    let Some(alive) = keep_or_drop(conn).await else {
                        break;
                    };
                    conn = alive;
                    let partitions = Instant::now() >= partitions_due;
                    match duties(&pool, partitions).await {
                        Ok(_) if partitions => {
                            partitions_due = Instant::now() + cadence.partitions_every;
                        }
                        Ok(_) => {}
                        Err(error) => warn!(%error, "leader duties failed; retrying next tick"),
                    }
                    if Instant::now() >= sweep_due {
                        let identity = sweep_identity(&db).await;
                        if let Err(error) = &identity {
                            warn!(%error, "sign-in sweep failed; retrying next tick");
                        }
                        let retention = sweep_retention(&db).await;
                        if let Err(error) = &retention {
                            warn!(%error, "retention sweep failed; retrying next tick");
                        }
                        if identity.is_ok() && retention.is_ok() {
                            sweep_due = Instant::now() + cadence.sweep_every;
                        }
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
