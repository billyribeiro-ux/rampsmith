//! The queue's error record, written by Rust and TypeScript workers alike (PLAN §10).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Stored in `jobs.last_error` when an attempt fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct JobError {
    /// Stable, `snake_case` reason, such as `shopify_throttled` or `payload_invalid`.
    pub code: String,
    /// What went wrong, for operators. Never contains tokens, theme source or personal data.
    pub message: String,
    /// Whether the job was scheduled for another attempt.
    pub retryable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_to_the_stored_shape() {
        let e = JobError {
            code: "shopify_throttled".to_owned(),
            message: "429".to_owned(),
            retryable: true,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({"code": "shopify_throttled", "message": "429", "retryable": true})
        );
    }

    #[test]
    fn rejects_unknown_members() {
        let wire = json!({"code": "x", "message": "y", "retryable": false, "stack": "..."});
        assert!(serde_json::from_value::<JobError>(wire).is_err());
    }
}
