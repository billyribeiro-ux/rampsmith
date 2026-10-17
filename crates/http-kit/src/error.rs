use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use contracts::{FieldError, Problem, ProblemCode};
use db::DbError;
use tracing::{error, warn};

/// The media type of every error body (RFC 9457).
pub const PROBLEM_JSON: &str = "application/problem+json";

/// An error a handler returns; rendered as problem+json with the request's trace id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    problem: Problem,
}

impl ApiError {
    /// An error whose status, title and type follow from `code`.
    #[must_use]
    pub fn new(code: ProblemCode) -> Self {
        Self {
            problem: Problem::new(code),
        }
    }

    /// Adds an explanation for this occurrence. It reaches the client: never put tokens,
    /// theme source or personal data in it.
    #[must_use]
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.problem = self.problem.with_detail(detail);
        self
    }

    /// Adds field-level validation errors.
    #[must_use]
    pub fn errors(mut self, errors: Vec<FieldError>) -> Self {
        self.problem = self.problem.with_errors(errors);
        self
    }

    /// The stable code.
    #[must_use]
    pub const fn code(&self) -> ProblemCode {
        self.problem.code
    }

    /// The problem body, without the trace id that rendering adds.
    #[must_use]
    pub const fn problem(&self) -> &Problem {
        &self.problem
    }
}

impl From<ProblemCode> for ApiError {
    fn from(code: ProblemCode) -> Self {
        Self::new(code)
    }
}

impl From<DbError> for ApiError {
    /// Maps database failures to stable codes. Constraint and column names stay in the
    /// logs; clients learn only what kind of failure it was.
    fn from(error: DbError) -> Self {
        match error {
            DbError::Invalid(constraint) => {
                warn!(%constraint, "request broke a database constraint");
                Self::new(ProblemCode::ValidationFailed).detail("The request breaks a data rule.")
            }
            DbError::Conflict(constraint) => {
                warn!(%constraint, "request conflicted with existing data");
                Self::new(ProblemCode::Conflict).detail("The data changed or already exists.")
            }
            DbError::Forbidden => Self::new(ProblemCode::Forbidden),
            other => {
                error!(error = %other, "database failure");
                Self::new(ProblemCode::Internal)
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut problem = self.problem;
        if problem.trace_id.is_none() {
            problem.trace_id = telemetry::trace_id(&tracing::Span::current());
        }
        let status =
            StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut response = (status, Json(problem)).into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON));
        response
    }
}
