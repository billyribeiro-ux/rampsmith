//! The job protocol of PLAN §10, shared with the TypeScript engine (ADR-003, ADR-018).
//!
//! Jobs are rows in `jobs`, claimed with `FOR UPDATE SKIP LOCKED` under a lease. Delivery
//! is at least once, so every side effect must be idempotent. The attempt number is a
//! fencing token: a worker that lost its lease can never complete or fail a job another
//! worker now holds.

mod backoff;
mod error;
mod ops;
mod worker;

pub use backoff::retry_delay;
pub use error::QueueError;
pub use ops::{
    CHANNEL, ClaimedJob, Enqueued, FailOutcome, Failure, Lease, NewJob, cancel_tenant_jobs, claim,
    complete, enqueue, fail, heartbeat, reap_expired, retry_dead,
};
pub use worker::{WorkerConfig, run};
