//! The queue's error record, written by Rust and TypeScript workers alike (PLAN §10).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

/// Payload of `shopify.token_refresh` jobs, schema `shopify.token_refresh@1` (PLAN §10, ADR-022).
/// The job's tenant is the shop's tenant. Runs in `ctl`: refreshes the shop's offline token
/// if it is within ten minutes of expiry, then schedules the next weekly run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShopifyTokenRefresh {
    /// The `shopify_shops.id` to refresh.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub shop_id: Uuid,
}

impl ShopifyTokenRefresh {
    /// The queue.
    pub const QUEUE: &'static str = "shopify.token_refresh";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "shopify.token_refresh@1";
}

/// Payload of `scan.page` jobs, schema `scan.page@1` (PLAN §10, §11). The job's tenant owns the
/// site. Runs in the engine: loads `url` in Chromium through egress, runs axe-core, and records
/// the findings against the scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanPage {
    /// The `scans.id` this page belongs to.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` the page is on; it must be verified.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The page to load: an `https://` URL on the site's host.
    #[schemars(extend("format" = "uri"))]
    pub url: String,
}

impl ScanPage {
    /// The queue.
    pub const QUEUE: &'static str = "scan.page";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "scan.page@1";
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
    fn the_token_refresh_payload_round_trips_and_is_strict() {
        let id = Uuid::from_u128(7);
        let wire = json!({"shop_id": id.to_string()});
        let payload: ShopifyTokenRefresh = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(payload.shop_id, id);
        assert_eq!(serde_json::to_value(payload).unwrap(), wire);
        assert!(serde_json::from_value::<ShopifyTokenRefresh>(json!({"shop_id": "x"})).is_err());
        assert!(
            serde_json::from_value::<ShopifyTokenRefresh>(
                json!({"shop_id": id.to_string(), "extra": 1})
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_unknown_members() {
        let wire = json!({"code": "x", "message": "y", "retryable": false, "stack": "..."});
        assert!(serde_json::from_value::<JobError>(wire).is_err());
    }
}
