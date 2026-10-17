//! HTTP plumbing shared by Rampsmith's Axum services (PLAN §8, §18, §21).
//!
//! - [`ApiError`]: every error crosses HTTP as RFC 9457 `application/problem+json` with a
//!   stable [`ProblemCode`].
//! - [`with_middleware`]: request ids, a span per request, sensitive-header redaction,
//!   panic catching, a body limit and a timeout. Any error response a layer produces
//!   without a body (timeout, body limit, unknown route) is rewritten as problem+json.

mod error;
mod middleware;

pub use contracts::{FieldError, Problem, ProblemCode};
pub use error::{ApiError, PROBLEM_JSON};
pub use middleware::{Limits, with_middleware};
