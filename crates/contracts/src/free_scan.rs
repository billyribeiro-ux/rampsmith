//! The free scanner's contracts (PLAN §16, ADR-265): the job the api enqueues for an anonymous
//! scan and the result the engine stores. No tenant owns either: a free scan belongs to the
//! visitor who asked and lives for 24 hours.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// Most failure groups a result lists.
pub const MAX_FAILURE_GROUPS: usize = 20;
/// Examples shown per failure group (PLAN §16).
pub const MAX_EXAMPLES: usize = 3;
/// Pages a free scan checks: the home page and two linked pages (PLAN §16).
pub const MAX_PAGES: usize = 3;
/// Longest example snippet, in characters.
pub const MAX_SNIPPET_CHARS: usize = 240;

/// Payload of `free_scan.run` jobs, schema `free_scan.run@1`. Runs in the engine for no tenant:
/// reads the `free_scans` row, checks `robots.txt`, scans the home page and up to two linked
/// pages at one viewport through egress, and stores the result on the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FreeScanRun {
    /// The `free_scans.id` to run.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub free_scan_id: Uuid,
}

impl FreeScanRun {
    /// The queue.
    pub const QUEUE: &'static str = "free_scan.run";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "free_scan.run@1";
}

/// One example of a failure: a page and the offending element's markup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FreeScanExample {
    /// The page the element is on.
    pub page: String,
    /// The element's markup, scrubbed and cut to a few hundred characters.
    pub snippet: String,
}

/// One kind of failure on the scanned pages, with up to three examples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FreeScanFailure {
    /// The rule's id, such as `color-contrast`.
    pub rule_id: String,
    /// What the failure is, in plain words.
    pub title: String,
    /// The WCAG 2.2 success criterion, such as `1.4.3`.
    pub criterion: String,
    /// How many elements failed across the scanned pages.
    pub count: u32,
    /// At most three.
    pub examples: Vec<FreeScanExample>,
}

/// What a free scan found (PLAN §16): checks passed of checks run, and the failures by type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FreeScanResult {
    /// The scanned domain, without a leading `www.`.
    pub domain: String,
    /// When the scan finished, RFC 3339.
    pub scanned_at: String,
    /// The pages checked: the home page and up to two linked pages.
    pub pages: Vec<String>,
    /// Automated checks that passed.
    pub checks_passed: u32,
    /// Automated checks that ran.
    pub checks_run: u32,
    /// Failures, most numerous first.
    pub failures: Vec<FreeScanFailure>,
}

impl FreeScanResult {
    /// Whether the result keeps to the limits the engine promises: a hostile or buggy writer of
    /// the `free_scans` row cannot make the api serve more than the page can show.
    #[must_use]
    pub fn within_limits(&self) -> bool {
        self.pages.len() <= MAX_PAGES
            && self.checks_passed <= self.checks_run
            && self.failures.len() <= MAX_FAILURE_GROUPS
            && self.failures.iter().all(|f| {
                f.examples.len() <= MAX_EXAMPLES
                    && f.examples
                        .iter()
                        .all(|e| e.snippet.chars().count() <= MAX_SNIPPET_CHARS)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_run_payload_round_trips_and_is_strict() {
        let wire = json!({"free_scan_id": Uuid::from_u128(9).to_string()});
        let run: FreeScanRun = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(run).unwrap(), wire);
        assert!(
            serde_json::from_value::<FreeScanRun>(
                json!({"free_scan_id": Uuid::from_u128(9).to_string(), "x": 1})
            )
            .is_err()
        );
    }

    fn result(examples: usize, snippet: usize) -> FreeScanResult {
        FreeScanResult {
            domain: "example.com".to_owned(),
            scanned_at: "2026-10-22T12:00:00Z".to_owned(),
            pages: vec!["https://example.com/".to_owned()],
            checks_passed: 5,
            checks_run: 6,
            failures: vec![FreeScanFailure {
                rule_id: "image-alt".to_owned(),
                title: "Images need alternative text".to_owned(),
                criterion: "1.1.1".to_owned(),
                count: 9,
                examples: (0..examples)
                    .map(|_| FreeScanExample {
                        page: "https://example.com/".to_owned(),
                        snippet: "x".repeat(snippet),
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn limits_hold_at_the_edge_and_refuse_beyond_it() {
        assert!(result(MAX_EXAMPLES, MAX_SNIPPET_CHARS).within_limits());
        assert!(!result(MAX_EXAMPLES + 1, 10).within_limits());
        assert!(!result(1, MAX_SNIPPET_CHARS + 1).within_limits());
        let mut passed_more_than_run = result(1, 10);
        passed_more_than_run.checks_passed = 7;
        assert!(!passed_more_than_run.within_limits());
    }
}
