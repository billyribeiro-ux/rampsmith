//! A worker loop: claim, run with heartbeats, then complete or fail (PLAN §10).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use crate::{
    CHANNEL, ClaimedJob, FailOutcome, Failure, Lease, QueueError, claim, complete, fail, heartbeat,
};

/// How one worker claims and runs jobs of one queue.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// The queue to claim from.
    pub queue: String,
    /// A unique id for this worker process, stored in `locked_by`.
    pub worker_id: String,
    /// Lease length; heartbeats extend it every third of it.
    pub lease: Duration,
    /// Poll interval in case a notification is missed (PLAN §10: 5 seconds).
    pub poll_interval: Duration,
    /// Jobs run at once by this worker.
    pub concurrency: usize,
}

impl WorkerConfig {
    /// A worker with a 30-second lease, a 5-second poll and one job at a time.
    #[must_use]
    pub fn new(queue: impl Into<String>, worker_id: impl Into<String>) -> Self {
        Self {
            queue: queue.into(),
            worker_id: worker_id.into(),
            lease: Duration::from_secs(30),
            poll_interval: Duration::from_secs(5),
            concurrency: 1,
        }
    }
}

/// Runs the worker until `shutdown` resolves, then waits for jobs in flight.
///
/// `handler` must make its side effects idempotent: a job can run again after a crash
/// between the effect and the completion. When a heartbeat finds the lease lost, the
/// handler's future is dropped and the job is left to its new owner.
pub async fn run<H, F, S>(
    pool: PgPool,
    config: WorkerConfig,
    handler: H,
    shutdown: S,
) -> Result<(), QueueError>
where
    H: Fn(ClaimedJob) -> F + Send + Sync + 'static,
    F: Future<Output = Result<(), Failure>> + Send + 'static,
    S: Future<Output = ()> + Send,
{
    let handler = Arc::new(handler);
    let slots = Arc::new(Semaphore::new(config.concurrency.max(1)));
    let mut listener = PgListener::connect_with(&pool).await?;
    listener.listen(CHANNEL).await?;
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    info!(queue = %config.queue, worker = %config.worker_id, "worker started");

    loop {
        while tasks.try_join_next().is_some() {}
        let free = i64::try_from(slots.available_permits()).unwrap_or(0);
        if free > 0 {
            match claim(&pool, &config.queue, free, &config.worker_id, config.lease).await {
                Ok(jobs) if !jobs.is_empty() => {
                    for job in jobs {
                        let Ok(permit) = Arc::clone(&slots).acquire_owned().await else {
                            break;
                        };
                        tasks.spawn(attempt(
                            pool.clone(),
                            Arc::clone(&handler),
                            job,
                            config.lease,
                            permit,
                        ));
                    }
                    continue;
                }
                Ok(_) => {}
                Err(error) => {
                    warn!(queue = %config.queue, %error, "claim failed; retrying after the poll interval");
                }
            }
        }
        tokio::select! {
            () = &mut shutdown => break,
            note = listener.recv() => match note {
                Ok(note) if note.payload() == config.queue => debug!(queue = %config.queue, "notified"),
                Ok(_) => {}
                Err(error) => {
                    warn!(%error, "listener failed; polling until it reconnects");
                    tokio::time::sleep(config.poll_interval).await;
                }
            },
            () = tokio::time::sleep(config.poll_interval) => {}
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }

    info!(queue = %config.queue, in_flight = tasks.len(), "worker stopping");
    while tasks.join_next().await.is_some() {}
    Ok(())
}

/// Runs one attempt, heartbeating every third of the lease.
async fn attempt<H, F>(
    pool: PgPool,
    handler: Arc<H>,
    job: ClaimedJob,
    lease: Duration,
    _slot: OwnedSemaphorePermit,
) where
    H: Fn(ClaimedJob) -> F + Send + Sync + 'static,
    F: Future<Output = Result<(), Failure>> + Send + 'static,
{
    let held: Lease = job.lease.clone();
    let queue = job.queue.clone();
    let mut beat = tokio::time::interval(lease / 3);
    beat.tick().await;
    let work = handler(job);
    tokio::pin!(work);
    let outcome = loop {
        tokio::select! {
            result = &mut work => break Some(result),
            _ = beat.tick() => match heartbeat(&pool, &held, lease).await {
                Ok(true) => {}
                Ok(false) => break None,
                Err(error) => warn!(job = %held.job_id, %error, "heartbeat failed; the lease may expire"),
            },
        }
    };
    match outcome {
        None => {
            warn!(job = %held.job_id, %queue, attempt = held.attempt, "lease lost; attempt abandoned");
        }
        Some(Ok(())) => match complete(&pool, &held).await {
            Ok(()) => debug!(job = %held.job_id, %queue, attempt = held.attempt, "job succeeded"),
            Err(error) => warn!(job = %held.job_id, %queue, %error, "could not complete"),
        },
        Some(Err(failure)) => match fail(&pool, &held, &failure, rand::random::<f64>()).await {
            Ok(FailOutcome::Retrying { run_at }) => {
                info!(job = %held.job_id, %queue, attempt = held.attempt, %run_at, "job will retry");
            }
            Ok(FailOutcome::Dead) => {
                warn!(job = %held.job_id, %queue, attempt = held.attempt, "job is dead");
            }
            Err(error) => warn!(job = %held.job_id, %queue, %error, "could not record the failure"),
        },
    }
}
