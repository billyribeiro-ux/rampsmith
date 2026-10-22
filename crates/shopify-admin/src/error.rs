//! What can go wrong with an Admin API call, as typed errors.
//!
//! Nothing here keeps a response body, a header or the access token: Shopify's messages are
//! kept only for `userErrors`, which the caller shows to the merchant or records by code.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One entry of a mutation's `userErrors`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserError {
    /// The input path the error is about, such as `["files", "0", "alt"]`.
    #[serde(default)]
    pub field: Option<Vec<String>>,
    /// Shopify's explanation.
    pub message: String,
    /// Shopify's error code, on payloads that have one.
    #[serde(default)]
    pub code: Option<String>,
}

/// Why an Admin API call failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdminError {
    /// HTTP 401: the access token is invalid, expired or revoked, which is what an uninstall
    /// looks like to the app.
    #[error("Shopify rejected the access token")]
    Unauthorized,
    /// `ACCESS_DENIED` or HTTP 403 from the GraphQL layer: the app lacks the access scope or
    /// the object is not available to it. A retry cannot fix it.
    #[error("Shopify denied access to the requested data")]
    AccessDenied,
    /// HTTP 402, 403 or 423 from the platform: the shop is frozen, forbidden or locked.
    #[error("the shop is not available (HTTP {status})")]
    ShopUnavailable {
        /// The status.
        status: u16,
    },
    /// HTTP 404: the shop's endpoint does not exist, for example after the store was deleted.
    #[error("the shop was not found")]
    NotFound,
    /// The cost-based rate limit was hit and the retries inside the call ran out.
    #[error("Shopify throttled the call")]
    Throttled {
        /// How long Shopify's reported restore rate says to wait.
        retry_after: Duration,
    },
    /// HTTP 5xx, or `INTERNAL_SERVER_ERROR`.
    #[error("Shopify failed the call (HTTP {status})")]
    Upstream {
        /// The status, or 200 for an `INTERNAL_SERVER_ERROR` inside a 200 response.
        status: u16,
    },
    /// The request was refused for a reason a retry cannot fix (HTTP 4xx other than the above,
    /// including a redirect, which is never followed).
    #[error("Shopify rejected the call (HTTP {status})")]
    Rejected {
        /// The status.
        status: u16,
    },
    /// Connection failure or timeout.
    #[error("the call did not complete")]
    Transport,
    /// The response was not the shape the operation expects.
    #[error("Shopify's response could not be read")]
    Decode,
    /// The GraphQL layer answered with `errors` that are none of the above.
    #[error("the GraphQL call failed with {code}")]
    GraphQl {
        /// `extensions.code`, or `UNKNOWN`.
        code: String,
    },
    /// A mutation returned a non-empty `userErrors`. Never a silent success (PLAN §14).
    #[error("Shopify refused the change: {} user error(s)", .0.len())]
    User(Vec<UserError>),
    /// The object the call named does not exist (a `null` node).
    #[error("the resource does not exist")]
    ResourceMissing,
}

impl AdminError {
    /// Whether the same call may succeed later.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Throttled { .. } | Self::Upstream { .. } | Self::Transport
        )
    }

    /// Whether the access token is no longer valid: the app was uninstalled or the grant was
    /// revoked.
    #[must_use]
    pub const fn is_token_dead(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    /// A short stable code for logs, audit entries and `fixes.error_code`.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "token_rejected",
            Self::AccessDenied => "access_denied",
            Self::ShopUnavailable { .. } => "shop_unavailable",
            Self::NotFound => "shop_not_found",
            Self::Throttled { .. } => "throttled",
            Self::Upstream { .. } => "shopify_unavailable",
            Self::Rejected { .. } => "shopify_rejected",
            Self::Transport => "transport",
            Self::Decode => "decode",
            Self::GraphQl { .. } => "graphql_error",
            Self::User(_) => "user_errors",
            Self::ResourceMissing => "resource_missing",
        }
    }
}
