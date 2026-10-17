//! Errors from the GitHub client. No variant carries a token, a key, a request or response
//! body, or file content: GitHub's own `message` is kept (truncated) because it explains a
//! 403, 409 or 422, and JSON decoding errors keep only their position.

use std::fmt;
use std::time::Duration;

use crate::app::KeyError;
use crate::guard::{BranchRejection, PathRejection, StructureError};

/// Which GitHub rate limit was hit
/// (<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitKind {
    /// The hourly primary limit: `x-ratelimit-remaining` was `0`.
    Primary,
    /// A secondary limit (concurrency, content creation, or abuse detection).
    Secondary,
}

/// A JSON decoding failure, reduced to its category and position. `serde_json`'s message can
/// quote the offending value, which may be a token, so it is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError {
    /// `syntax`, `data`, `eof` or `io`.
    pub category: &'static str,
    /// 1-based line, 0 when unknown.
    pub line: usize,
    /// 1-based column, 0 when unknown.
    pub column: usize,
}

impl From<&serde_json::Error> for DecodeError {
    fn from(error: &serde_json::Error) -> Self {
        let category = match error.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "data",
            serde_json::error::Category::Eof => "eof",
        };
        Self {
            category,
            line: error.line(),
            column: error.column(),
        }
    }
}

impl From<serde_json::Error> for DecodeError {
    fn from(error: serde_json::Error) -> Self {
        Self::from(&error)
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid JSON ({} error at line {}, column {})",
            self.category, self.line, self.column
        )
    }
}

impl std::error::Error for DecodeError {}

/// How a request failed before GitHub answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// The request or the connection timed out.
    Timeout,
    /// The connection could not be made.
    Connect,
    /// The response body could not be read.
    Body,
    /// The request could not be built or sent.
    Request,
}

impl fmt::Display for TransportKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Timeout => "timed out",
            Self::Connect => "connection failed",
            Self::Body => "reading the response failed",
            Self::Request => "sending the request failed",
        })
    }
}

impl From<&reqwest::Error> for TransportKind {
    // reqwest's own message includes the URL; only the kind is kept.
    fn from(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else if error.is_connect() {
            Self::Connect
        } else if error.is_body() || error.is_decode() {
            Self::Body
        } else {
            Self::Request
        }
    }
}

/// Errors from the GitHub client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitHubError {
    /// The request did not get an HTTP answer.
    #[error("GitHub request {0}")]
    Transport(TransportKind),
    /// 401: the JWT or installation token was rejected. A cached installation token is
    /// dropped, so the next attempt mints a new one.
    #[error("GitHub rejected the credentials (401)")]
    Unauthorized,
    /// 403 that is not a rate limit: the installation lacks a permission or the repository.
    #[error("GitHub refused the request (403): {message}")]
    Forbidden {
        /// GitHub's message, truncated.
        message: String,
    },
    /// 404: the resource does not exist, or the installation cannot see it.
    #[error("GitHub could not find the resource (404)")]
    NotFound,
    /// 409: a conflict, such as an empty repository or a moved ref.
    #[error("GitHub reported a conflict (409): {message}")]
    Conflict {
        /// GitHub's message, truncated.
        message: String,
    },
    /// 422: validation failed, such as a ref that already exists or a non-fast-forward update.
    #[error("GitHub rejected the request (422): {message}")]
    Validation {
        /// GitHub's message, truncated.
        message: String,
    },
    /// 403 or 429 from a rate limit. Retry no earlier than `retry_after`.
    #[error("GitHub rate limit ({kind:?}); retry after {retry_after:?}")]
    RateLimited {
        /// Primary or secondary.
        kind: RateLimitKind,
        /// How long to wait, from `retry-after`, `x-ratelimit-reset`, or GitHub's one-minute
        /// default for secondary limits.
        retry_after: Duration,
    },
    /// 5xx.
    #[error("GitHub server error ({status})")]
    Server {
        /// The status code.
        status: u16,
    },
    /// Any other status, including redirects, which the client never follows.
    #[error("unexpected GitHub response status {status}")]
    UnexpectedStatus {
        /// The status code.
        status: u16,
    },
    /// The response body was larger than the configured limit.
    #[error("the GitHub response exceeded {limit} bytes")]
    ResponseTooLarge {
        /// The limit, in bytes.
        limit: usize,
    },
    /// The response was not the JSON expected.
    #[error("the GitHub response could not be decoded: {0}")]
    Decode(DecodeError),
    /// A recursive tree listing was truncated by GitHub, so the theme check would be partial.
    #[error("the repository tree is too large to list in one response")]
    TreeTruncated,
    /// The client configuration is unusable.
    #[error("invalid GitHub client configuration: {0}")]
    Config(&'static str),
    /// A request argument breaks a documented GitHub limit.
    #[error("invalid GitHub request: {0}")]
    InvalidRequest(&'static str),
    /// The App key or JWT failed.
    #[error(transparent)]
    Key(#[from] KeyError),
    /// A branch guard refused the branch.
    #[error(transparent)]
    Branch(#[from] BranchRejection),
    /// A path guard refused the path.
    #[error(transparent)]
    Path(#[from] PathRejection),
    /// The repository is not a Shopify theme.
    #[error(transparent)]
    Structure(#[from] StructureError),
}

impl GitHubError {
    /// Whether the same request may succeed later: rate limits, server errors and transport
    /// failures. Everything else needs a change first.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. } | Self::Server { .. } | Self::Transport(_)
        )
    }

    /// The earliest sensible retry, when GitHub said.
    #[must_use]
    pub const fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::RateLimited { retry_after, .. } => Some(*retry_after),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_errors_never_echo_response_values() {
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct Wanted {
            token: u64,
        }
        let body = br#"{"token": "ghs_SuperSecretTokenValue", "expires_at": 5}"#;
        let err = serde_json::from_slice::<Wanted>(body).unwrap_err();
        assert!(
            err.to_string().contains("ghs_SuperSecretTokenValue"),
            "precondition: serde_json quotes the value"
        );
        let decoded = DecodeError::from(err);
        let shown = format!("{decoded} {decoded:?} {}", GitHubError::Decode(decoded));
        assert!(!shown.contains("ghs_"), "{shown}");
        assert_eq!(decoded.category, "data");
        assert_eq!(decoded.line, 1);
    }

    #[test]
    fn only_transient_errors_are_retryable() {
        assert!(GitHubError::Server { status: 502 }.is_retryable());
        assert!(GitHubError::Transport(TransportKind::Timeout).is_retryable());
        let limited = GitHubError::RateLimited {
            kind: RateLimitKind::Secondary,
            retry_after: Duration::from_mins(1),
        };
        assert!(limited.is_retryable());
        assert_eq!(limited.retry_after(), Some(Duration::from_mins(1)));
        assert!(!GitHubError::NotFound.is_retryable());
        assert!(!GitHubError::Unauthorized.is_retryable());
        assert!(
            !GitHubError::Validation {
                message: String::new()
            }
            .is_retryable()
        );
        assert_eq!(GitHubError::NotFound.retry_after(), None);
    }
}
