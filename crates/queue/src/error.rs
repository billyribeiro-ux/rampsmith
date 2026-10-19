use thiserror::Error;

/// Errors from the job protocol.
#[derive(Debug, Error)]
pub enum QueueError {
    /// The lease is no longer held: it expired and was reaped, or another attempt owns the
    /// job. The caller must stop without side effects.
    #[error("the lease on this job is no longer held")]
    LeaseLost,
    /// The error record could not be encoded.
    #[error("cannot encode the job error: {0}")]
    Encode(serde_json::Error),
    /// The database failed.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}
