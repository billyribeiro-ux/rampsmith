//! RFC 9457 problem details, the only error shape that crosses HTTP (PLAN §8).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Stable, enumerated error code. Clients branch on this, never on `title` or `detail`.
///
/// Adding a code is a contract change; renaming or removing one is a breaking change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProblemCode {
    /// The request could not be parsed.
    BadRequest,
    /// The request parsed but a field is invalid; see `errors`.
    ValidationFailed,
    /// No valid credentials, such as a missing or expired session token.
    Unauthenticated,
    /// Valid credentials without permission for this resource.
    Forbidden,
    /// The resource does not exist or is not visible to this tenant.
    NotFound,
    /// The resource changed since it was read (compare-before-write failed).
    Conflict,
    /// The request body exceeds the endpoint's limit.
    PayloadTooLarge,
    /// Too many requests; retry later.
    RateLimited,
    /// An unexpected failure inside Rampsmith.
    Internal,
    /// A provider such as Shopify, GitHub or Anthropic failed.
    UpstreamFailed,
    /// Rampsmith is temporarily unable to serve the request.
    Unavailable,
}

impl ProblemCode {
    /// Every code, in declaration order.
    pub const ALL: [Self; 11] = [
        Self::BadRequest,
        Self::ValidationFailed,
        Self::Unauthenticated,
        Self::Forbidden,
        Self::NotFound,
        Self::Conflict,
        Self::PayloadTooLarge,
        Self::RateLimited,
        Self::Internal,
        Self::UpstreamFailed,
        Self::Unavailable,
    ];

    /// The HTTP status sent with this code.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            Self::BadRequest => 400,
            Self::Unauthenticated => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::PayloadTooLarge => 413,
            Self::ValidationFailed => 422,
            Self::RateLimited => 429,
            Self::Internal => 500,
            Self::UpstreamFailed => 502,
            Self::Unavailable => 503,
        }
    }

    /// Short, human-readable summary that does not change between occurrences.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::BadRequest => "Bad request",
            Self::ValidationFailed => "Validation failed",
            Self::Unauthenticated => "Authentication required",
            Self::Forbidden => "Forbidden",
            Self::NotFound => "Not found",
            Self::Conflict => "Conflict",
            Self::PayloadTooLarge => "Payload too large",
            Self::RateLimited => "Too many requests",
            Self::Internal => "Internal error",
            Self::UpstreamFailed => "Upstream provider failed",
            Self::Unavailable => "Service unavailable",
        }
    }

    /// The `snake_case` spelling used on the wire.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::ValidationFailed => "validation_failed",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RateLimited => "rate_limited",
            Self::Internal => "internal",
            Self::UpstreamFailed => "upstream_failed",
            Self::Unavailable => "unavailable",
        }
    }
}

/// One invalid field of a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FieldError {
    /// JSON path of the field, such as `shop` or `items.0.alt`.
    pub field: String,
    /// What is wrong, safe to show to the user.
    pub message: String,
}

/// An RFC 9457 `application/problem+json` body with Rampsmith's extension members.
///
/// Unknown members are ignored on input, as RFC 9457 requires of consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Problem {
    /// URI reference identifying the problem type: `/problems/<code>`.
    #[serde(rename = "type")]
    pub type_uri: String,
    /// Short summary of the problem type.
    pub title: String,
    /// The HTTP status code.
    pub status: u16,
    /// Explanation specific to this occurrence. Never contains tokens or personal data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// URI reference identifying this occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Stable machine-readable code.
    pub code: ProblemCode,
    /// W3C trace id of the request, for support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    /// Field-level errors when `code` is `validation_failed`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<FieldError>,
}

impl Problem {
    /// A problem whose type, title and status follow from `code`.
    #[must_use]
    pub fn new(code: ProblemCode) -> Self {
        Self {
            type_uri: format!("/problems/{}", code.as_str()),
            title: code.title().to_owned(),
            status: code.status(),
            detail: None,
            instance: None,
            code,
            trace_id: None,
            errors: Vec::new(),
        }
    }

    /// Adds an occurrence-specific explanation.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Adds field-level validation errors.
    #[must_use]
    pub fn with_errors(mut self, errors: Vec<FieldError>) -> Self {
        self.errors = errors;
        self
    }

    /// Attaches the request's trace id.
    #[must_use]
    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_code_maps_to_a_client_or_server_error_status() {
        for code in ProblemCode::ALL {
            assert!((400..600).contains(&code.status()), "{code:?}");
        }
    }

    #[test]
    fn codes_map_to_the_expected_statuses() {
        assert_eq!(ProblemCode::BadRequest.status(), 400);
        assert_eq!(ProblemCode::ValidationFailed.status(), 422);
        assert_eq!(ProblemCode::Unauthenticated.status(), 401);
        assert_eq!(ProblemCode::Forbidden.status(), 403);
        assert_eq!(ProblemCode::NotFound.status(), 404);
        assert_eq!(ProblemCode::Conflict.status(), 409);
        assert_eq!(ProblemCode::PayloadTooLarge.status(), 413);
        assert_eq!(ProblemCode::RateLimited.status(), 429);
        assert_eq!(ProblemCode::Internal.status(), 500);
        assert_eq!(ProblemCode::UpstreamFailed.status(), 502);
        assert_eq!(ProblemCode::Unavailable.status(), 503);
    }

    #[test]
    fn codes_serialize_as_stable_snake_case_strings() {
        assert_eq!(
            serde_json::to_value(ProblemCode::ValidationFailed).unwrap(),
            json!("validation_failed")
        );
        assert_eq!(
            serde_json::to_value(ProblemCode::RateLimited).unwrap(),
            json!("rate_limited")
        );
    }

    #[test]
    fn as_str_matches_the_serde_spelling_for_every_code() {
        for code in ProblemCode::ALL {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(code.as_str()));
        }
    }

    #[test]
    fn a_new_problem_takes_its_status_title_and_type_from_the_code() {
        let p = Problem::new(ProblemCode::NotFound);
        assert_eq!(p.status, 404);
        assert_eq!(p.title, "Not found");
        assert_eq!(p.type_uri, "/problems/not_found");
        assert_eq!(p.code, ProblemCode::NotFound);
    }

    #[test]
    fn serializes_type_under_its_rfc_name_and_omits_empty_members() {
        let p =
            Problem::new(ProblemCode::Conflict).with_detail("The value changed since it was read.");
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            json!({
                "type": "/problems/conflict",
                "title": "Conflict",
                "status": 409,
                "detail": "The value changed since it was read.",
                "code": "conflict",
            })
        );
    }

    #[test]
    fn carries_field_errors_for_validation_failures() {
        let p = Problem::new(ProblemCode::ValidationFailed).with_errors(vec![FieldError {
            field: "shop".to_owned(),
            message: "must be a myshopify.com domain".to_owned(),
        }]);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["errors"][0]["field"], "shop");
    }

    #[test]
    fn round_trips_and_tolerates_unknown_extension_members() {
        let wire = json!({
            "type": "/problems/rate_limited",
            "title": "Too many requests",
            "status": 429,
            "code": "rate_limited",
            "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
            "retry_after_seconds": 30
        });
        let p: Problem = serde_json::from_value(wire).unwrap();
        assert_eq!(p.code, ProblemCode::RateLimited);
        assert_eq!(
            p.trace_id.as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736")
        );
    }
}
