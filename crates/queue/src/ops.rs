//! The five operations (PLAN §10) plus the reaper and operator actions.

use std::time::Duration;

use contracts::JobError;
use serde_json::Value;
use sqlx::PgExecutor;
use sqlx::postgres::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{QueueError, retry_delay};

/// The `LISTEN`/`NOTIFY` channel; the payload is the queue name.
pub const CHANNEL: &str = "jobs";

/// A job to enqueue.
#[derive(Debug, Clone, PartialEq)]
pub struct NewJob {
    /// The queue, such as `scan.page`.
    pub queue: String,
    /// The payload's schema and version, such as `scan.page@1`.
    pub payload_schema: String,
    /// The payload, valid against `payload_schema`.
    pub payload: Value,
    /// The tenant the job acts for; `None` for system jobs.
    pub tenant_id: Option<Uuid>,
    /// Higher runs first.
    pub priority: i16,
    /// Earliest start; now when `None`.
    pub run_at: Option<OffsetDateTime>,
    /// Attempts before the job is dead.
    pub max_attempts: i32,
    /// Enqueuing the same key twice creates one job.
    pub idempotency_key: Option<String>,
    /// The job that enqueued this one.
    pub parent_id: Option<Uuid>,
    /// W3C trace context of the enqueuer.
    pub traceparent: Option<String>,
}

impl NewJob {
    /// A system job with default priority and eight attempts.
    #[must_use]
    pub fn new(
        queue: impl Into<String>,
        payload_schema: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            queue: queue.into(),
            payload_schema: payload_schema.into(),
            payload,
            tenant_id: None,
            priority: 0,
            run_at: None,
            max_attempts: 8,
            idempotency_key: None,
            parent_id: None,
            traceparent: None,
        }
    }

    /// Acts for `tenant`.
    #[must_use]
    pub const fn for_tenant(mut self, tenant: Uuid) -> Self {
        self.tenant_id = Some(tenant);
        self
    }

    /// Deduplicates on `key`.
    #[must_use]
    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// Starts no earlier than `at`.
    #[must_use]
    pub const fn run_at(mut self, at: OffsetDateTime) -> Self {
        self.run_at = Some(at);
        self
    }

    /// Runs before lower priorities.
    #[must_use]
    pub const fn priority(mut self, priority: i16) -> Self {
        self.priority = priority;
        self
    }

    /// Allows `n` attempts.
    #[must_use]
    pub const fn max_attempts(mut self, n: i32) -> Self {
        self.max_attempts = n;
        self
    }

    /// Records the enqueuer's trace context.
    #[must_use]
    pub fn traceparent(mut self, traceparent: impl Into<String>) -> Self {
        self.traceparent = Some(traceparent.into());
        self
    }
}

/// What [`enqueue`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueued {
    /// A new job with this id.
    Created(Uuid),
    /// A job with the same idempotency key already exists.
    Duplicate,
}

/// A worker's hold on one attempt of one job. The attempt number fences: an outdated
/// lease can neither heartbeat, complete nor fail the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    /// The job.
    pub job_id: Uuid,
    /// The worker holding it.
    pub worker: String,
    /// The attempt this lease covers.
    pub attempt: i32,
}

/// A job a worker now holds.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedJob {
    /// The lease to heartbeat, complete or fail with.
    pub lease: Lease,
    /// The queue.
    pub queue: String,
    /// The payload's schema and version.
    pub payload_schema: String,
    /// The payload.
    pub payload: Value,
    /// The tenant to scope every query to, if any.
    pub tenant_id: Option<Uuid>,
    /// Attempts allowed.
    pub max_attempts: i32,
    /// When the lease runs out unless extended.
    pub locked_until: OffsetDateTime,
    /// The enqueuer's trace context.
    pub traceparent: Option<String>,
}

/// Why an attempt failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// Worth another attempt after a backoff, such as a 429 or a timeout.
    Retryable(JobError),
    /// Will never succeed, such as an invalid payload.
    Permanent(JobError),
}

/// What [`fail`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOutcome {
    /// The job runs again at `run_at`.
    Retrying {
        /// When the next attempt may start.
        run_at: OffsetDateTime,
    },
    /// The job is dead: permanent failure or attempts exhausted. It alerts and is retried
    /// only by an operator.
    Dead,
}

/// Enqueues a job inside the caller's transaction, so it commits or rolls back with the
/// domain write that caused it. Workers are notified when the transaction commits. Without
/// an explicit `traceparent`, the current span's trace context is stored, so the worker's
/// span continues the same trace (PLAN §10).
pub async fn enqueue(conn: &mut PgConnection, job: &NewJob) -> Result<Enqueued, QueueError> {
    let traceparent = job
        .traceparent
        .clone()
        .or_else(|| telemetry::traceparent(&tracing::Span::current()));
    let id = sqlx::query_scalar!(
        r#"with inserted as (
             insert into jobs (id, queue, payload_schema, payload, tenant_id, priority, state,
                               max_attempts, run_at, idempotency_key, parent_id, traceparent)
             values ($1, $2, $3, $4, $5, $6, 'ready', $7, coalesce($8, now()), $9, $10, $11)
             on conflict (idempotency_key) do nothing
             returning id, queue
           )
           select id as "id!" from inserted, lateral (select pg_notify('jobs', inserted.queue)) as n"#,
        Uuid::now_v7(),
        job.queue,
        job.payload_schema,
        job.payload,
        job.tenant_id,
        job.priority,
        job.max_attempts,
        job.run_at,
        job.idempotency_key,
        job.parent_id,
        traceparent,
    )
    .fetch_optional(conn)
    .await?;
    Ok(id.map_or(Enqueued::Duplicate, Enqueued::Created))
}

/// Claims up to `limit` ready jobs of `queue` for `worker`, in one round trip with no
/// contention between workers (`FOR UPDATE SKIP LOCKED`).
pub async fn claim<'c>(
    executor: impl PgExecutor<'c>,
    queue: &str,
    limit: i64,
    worker: &str,
    lease: Duration,
) -> Result<Vec<ClaimedJob>, QueueError> {
    let rows = sqlx::query!(
        r#"with next as (
             select id from jobs
              where queue = $1 and state = 'ready' and run_at <= now()
              order by priority desc, run_at
              for update skip locked
              limit $2
           )
           update jobs j
              set state = 'running', attempts = j.attempts + 1,
                  locked_by = $3, locked_until = now() + make_interval(secs => $4)
             from next
            where j.id = next.id
        returning j.id, j.queue, j.payload_schema, j.payload, j.tenant_id, j.attempts,
                  j.max_attempts, j.locked_until as "locked_until!", j.traceparent, j.priority, j.run_at"#,
        queue,
        limit,
        worker,
        lease.as_secs_f64(),
    )
    .fetch_all(executor)
    .await?;
    let mut jobs: Vec<_> = rows
        .into_iter()
        .map(|r| {
            (
                (std::cmp::Reverse(r.priority), r.run_at),
                ClaimedJob {
                    lease: Lease {
                        job_id: r.id,
                        worker: worker.to_owned(),
                        attempt: r.attempts,
                    },
                    queue: r.queue,
                    payload_schema: r.payload_schema,
                    payload: r.payload,
                    tenant_id: r.tenant_id,
                    max_attempts: r.max_attempts,
                    locked_until: r.locked_until,
                    traceparent: r.traceparent,
                },
            )
        })
        .collect();
    // UPDATE ... RETURNING does not preserve the subquery's order; restore it.
    jobs.sort_by_key(|(order, _)| *order);
    Ok(jobs.into_iter().map(|(_, job)| job).collect())
}

/// Extends a lease to `lease` from now. Returns `false` when the lease is no longer held;
/// the worker must then stop the attempt without completing or failing it.
pub async fn heartbeat<'c>(
    executor: impl PgExecutor<'c>,
    lease: &Lease,
    duration: Duration,
) -> Result<bool, QueueError> {
    let updated = sqlx::query!(
        r#"update jobs set locked_until = now() + make_interval(secs => $4)
            where id = $1 and locked_by = $2 and attempts = $3 and state = 'running'"#,
        lease.job_id,
        lease.worker,
        lease.attempt,
        duration.as_secs_f64(),
    )
    .execute(executor)
    .await?;
    Ok(updated.rows_affected() == 1)
}

/// Marks the attempt succeeded. Fails with [`QueueError::LeaseLost`] when the lease is no
/// longer held, in which case another attempt owns the job.
pub async fn complete<'c>(executor: impl PgExecutor<'c>, lease: &Lease) -> Result<(), QueueError> {
    let updated = sqlx::query!(
        r#"update jobs set state = 'succeeded', finished_at = now(), locked_by = null, locked_until = null
            where id = $1 and locked_by = $2 and attempts = $3 and state = 'running'"#,
        lease.job_id,
        lease.worker,
        lease.attempt,
    )
    .execute(executor)
    .await?;
    if updated.rows_affected() == 1 {
        Ok(())
    } else {
        Err(QueueError::LeaseLost)
    }
}

/// Records a failed attempt. A retryable failure with attempts left becomes ready again
/// after [`retry_delay`]; anything else is dead. `jitter` is a uniform sample in `[0, 1)`.
pub async fn fail<'c>(
    executor: impl PgExecutor<'c>,
    lease: &Lease,
    failure: &Failure,
    jitter: f64,
) -> Result<FailOutcome, QueueError> {
    let (retryable, error) = match failure {
        Failure::Retryable(e) => (true, e),
        Failure::Permanent(e) => (false, e),
    };
    let attempt = u32::try_from(lease.attempt).unwrap_or(1);
    let delay = retry_delay(attempt, jitter).as_secs_f64();
    let error = serde_json::to_value(error).map_err(QueueError::Encode)?;
    let row = sqlx::query!(
        r#"with decision as (
             select id, ($4::bool and attempts < max_attempts) as retry from jobs
              where id = $1 and locked_by = $2 and attempts = $3 and state = 'running'
              for update
           )
           update jobs j set
             state = case when d.retry then 'ready' else 'dead' end,
             run_at = case when d.retry then now() + make_interval(secs => $5) else j.run_at end,
             finished_at = case when d.retry then null else now() end,
             last_error = jsonb_set($6::jsonb, '{retryable}', to_jsonb(d.retry)),
             locked_by = null,
             locked_until = null
           from decision d
           where j.id = d.id
           returning j.state, j.run_at"#,
        lease.job_id,
        lease.worker,
        lease.attempt,
        retryable,
        delay,
        error,
    )
    .fetch_optional(executor)
    .await?;
    match row {
        None => Err(QueueError::LeaseLost),
        Some(r) if r.state == "ready" => Ok(FailOutcome::Retrying { run_at: r.run_at }),
        Some(_) => Ok(FailOutcome::Dead),
    }
}

/// Returns jobs whose lease expired to `ready`, or to `dead` when no attempts remain.
/// Runs only in the `ctl` instance holding scheduler leadership (PLAN §10).
pub async fn reap_expired<'c>(executor: impl PgExecutor<'c>) -> Result<u64, QueueError> {
    let updated = sqlx::query!(
        r#"update jobs set
             state = case when attempts < max_attempts then 'ready' else 'dead' end,
             run_at = now(),
             finished_at = case when attempts < max_attempts then null else now() end,
             locked_by = null,
             locked_until = null,
             last_error = jsonb_build_object(
               'code', 'lease_expired',
               'message', 'the worker lost its lease before finishing',
               'retryable', attempts < max_attempts)
           where state = 'running' and locked_until < now()"#,
    )
    .execute(executor)
    .await?;
    Ok(updated.rows_affected())
}

/// Makes a dead job ready again with a fresh attempt budget. Operator action through
/// `rsctl jobs retry` only. Returns `false` when the job is not dead.
pub async fn retry_dead<'c>(
    executor: impl PgExecutor<'c>,
    job_id: Uuid,
) -> Result<bool, QueueError> {
    let updated = sqlx::query!(
        r#"update jobs set state = 'ready', attempts = 0, run_at = now(), finished_at = null
            where id = $1 and state = 'dead'"#,
        job_id,
    )
    .execute(executor)
    .await?;
    Ok(updated.rows_affected() == 1)
}

/// Cancels a tenant's jobs that have not started, such as after `app/uninstalled`.
pub async fn cancel_tenant_jobs<'c>(
    executor: impl PgExecutor<'c>,
    tenant: Uuid,
) -> Result<u64, QueueError> {
    let updated = sqlx::query!(
        r#"update jobs set state = 'cancelled', finished_at = now()
            where tenant_id = $1 and state = 'ready'"#,
        tenant,
    )
    .execute(executor)
    .await?;
    Ok(updated.rows_affected())
}

/// Jobs waiting, running or dead in one queue, for the depth and age metrics (PLAN §10, §21).
#[derive(Debug, Clone, PartialEq)]
pub struct Depth {
    /// The queue.
    pub queue: String,
    /// `ready`, `running` or `dead`.
    pub state: String,
    /// How many jobs are in that state.
    pub count: i64,
    /// For `ready`: seconds since the oldest due job became runnable.
    pub oldest_ready_seconds: Option<f64>,
}

/// Depth by queue and state, and the age of the oldest due job. Finished states are left out:
/// they only grow.
pub async fn depth<'c>(executor: impl PgExecutor<'c>) -> Result<Vec<Depth>, QueueError> {
    let rows = sqlx::query!(
        r#"select queue, state, count(*) as "count!",
                  extract(epoch from now() - min(run_at) filter (where state = 'ready' and run_at <= now()))::float8
                    as oldest_ready_seconds
             from jobs
            where state in ('ready', 'running', 'dead')
            group by queue, state
            order by queue, state"#,
    )
    .fetch_all(executor)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Depth {
            queue: r.queue,
            state: r.state,
            count: r.count,
            oldest_ready_seconds: r.oldest_ready_seconds,
        })
        .collect())
}
