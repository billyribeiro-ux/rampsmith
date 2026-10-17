use thiserror::Error;

/// Errors from the database layer. Messages name constraints and types, never values, so
/// they are safe to log (PLAN §8: no personal data or tokens in logs).
#[derive(Debug, Error)]
pub enum DbError {
    /// The input broke a constraint: a check, a foreign key, a not-null or a length limit.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// A unique constraint was violated.
    #[error("conflict: {0}")]
    Conflict(String),
    /// Row-level security rejected the write.
    #[error("forbidden by row-level security")]
    Forbidden,
    /// A stored value could not be mapped to its domain type.
    #[error("stored {what} is not valid")]
    Corrupt {
        /// The column or type that failed to map.
        what: &'static str,
    },
    /// Any other database failure.
    #[error("database error: {0}")]
    Sqlx(sqlx::Error),
    /// Applying migrations failed.
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        let Some(db) = error.as_database_error() else {
            return Self::Sqlx(error);
        };
        let constraint = db.constraint().unwrap_or("unnamed constraint").to_owned();
        match db.code().as_deref() {
            // check_violation, foreign_key_violation, not_null_violation, string_data_right_truncation
            Some("23514" | "23503" | "23502" | "22001") => Self::Invalid(constraint),
            Some("23505") => Self::Conflict(constraint),
            Some("42501") => Self::Forbidden,
            _ => Self::Sqlx(error),
        }
    }
}

/// Maps a stored string to its domain enum, or reports corruption.
pub(crate) fn parse<T: std::str::FromStr>(value: &str, what: &'static str) -> Result<T, DbError> {
    value.parse().map_err(|_| DbError::Corrupt { what })
}
