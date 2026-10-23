//! Job payloads of the GitHub pull-request channel (PLAN §15, ADR-141, ADR-290 to ADR-295).
//!
//! `ctl` holds the GitHub App's private key (the engine never does, like the Shopify tokens,
//! ADR-035), so every job that talks to GitHub runs there. Every payload carries ids only: the
//! rows they name are read inside the tenant's transaction, and nothing a webhook or a
//! storefront said is copied into a payload.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Payload of `github.sync_installation` jobs, schema `github.sync_installation@1`. Runs in
/// `ctl`: reads the installation's state and repositories from the GitHub API (never from a
/// webhook body, integration audit M1) and makes `github_installations` and `github_repos` match.
/// Queued when a store links an installation and whenever an event says it changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubSyncInstallation {
    /// The `github_installations.id` to refresh.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub installation_row: Uuid,
}

impl GithubSyncInstallation {
    /// The queue.
    pub const QUEUE: &'static str = "github.sync_installation";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.sync_installation@1";
}

/// Payload of `github.process_event` jobs, schema `github.process_event@1`. Runs in `ctl`:
/// handles one verified delivery already recorded in `github_events`. The body is read from that
/// row, never from the payload, and decides only which API read to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubProcessEvent {
    /// The `github_events.id` to process.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub event_id: Uuid,
}

impl GithubProcessEvent {
    /// The queue.
    pub const QUEUE: &'static str = "github.process_event";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.process_event@1";
    /// Attempts a job gets. GitHub redelivers nothing automatically, so the job carries the
    /// retries.
    pub const MAX_ATTEMPTS: i32 = 8;
}

/// Payload of `github.check_repository` jobs, schema `github.check_repository@1`. Runs in `ctl`:
/// reads the tree of the chosen repository's connected branch and records whether it is a
/// Shopify theme (`layout/theme.liquid`, `sections/`, `templates/`, `config/`; PLAN §15).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubCheckRepository {
    /// The `github_repos.id` to check.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub repo_row: Uuid,
}

impl GithubCheckRepository {
    /// The queue.
    pub const QUEUE: &'static str = "github.check_repository";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.check_repository@1";
}

/// Payload of `github.plan_batch` jobs, schema `github.plan_batch@1`. Runs in `ctl`: reads the
/// connected branch's head and the theme files from the repository (theme directories only,
/// through the read guards), stores them in `code_fix_files`, and queues `code_fix.patch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubPlanBatch {
    /// The `code_fix_batches.id` to read the files for.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub batch_row: Uuid,
}

impl GithubPlanBatch {
    /// The queue.
    pub const QUEUE: &'static str = "github.plan_batch";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.plan_batch@1";
}

/// Payload of `code_fix.patch` jobs, schema `code_fix.patch@1`. Runs in the engine: maps the
/// store's open findings to the files `ctl` stored, plans and applies the recipes, checks the
/// result with Theme Check, stores the patched files and the fixes, and queues
/// `github.open_pr`. The engine never talks to GitHub and never holds its key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeFixPatch {
    /// The `code_fix_batches.id` to patch.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub batch_row: Uuid,
}

impl CodeFixPatch {
    /// The queue.
    pub const QUEUE: &'static str = "code_fix.patch";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "code_fix.patch@1";
}

/// Payload of `github.open_pr` jobs, schema `github.open_pr@1`. Runs in `ctl`: turns the
/// engine's fixes into commits on `rampsmith/fix-<batch>`, opens (or updates) the pull request
/// against the connected branch, reports the verification check run, and deletes the stored
/// files. It never merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubOpenPullRequest {
    /// The `code_fix_batches.id` to open pull requests for.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub batch_row: Uuid,
}

impl GithubOpenPullRequest {
    /// The queue.
    pub const QUEUE: &'static str = "github.open_pr";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.open_pr@1";
}

/// Payload of `github.sync_pr` jobs, schema `github.sync_pr@1`. Runs in `ctl`: reads one pull
/// request Rampsmith opened from the GitHub API and records its state and head. A branch a person
/// edited is recorded, never overwritten (PLAN §15, audit L3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GithubSyncPullRequest {
    /// The `github_pull_requests.id` to refresh.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub pull_request_row: Uuid,
}

impl GithubSyncPullRequest {
    /// The queue.
    pub const QUEUE: &'static str = "github.sync_pr";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "github.sync_pr@1";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(n: u8) -> String {
        format!("00000000-0000-7000-8000-0000000000{n:02x}")
    }

    #[test]
    fn payloads_round_trip_and_refuse_unknown_members() {
        let wire = json!({"installation_row": id(1)});
        let parsed: GithubSyncInstallation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let wire = json!({"event_id": id(2)});
        let parsed: GithubProcessEvent = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let wire = json!({"repo_row": id(3)});
        let parsed: GithubCheckRepository = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let wire = json!({"batch_row": id(4)});
        let parsed: GithubPlanBatch = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let parsed: CodeFixPatch = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let parsed: GithubOpenPullRequest = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let wire = json!({"pull_request_row": id(5)});
        let parsed: GithubSyncPullRequest = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        assert!(
            serde_json::from_value::<CodeFixPatch>(json!({"batch_row": id(4), "files": []}))
                .is_err(),
            "a payload carries ids, never theme source"
        );
        assert!(
            serde_json::from_value::<GithubProcessEvent>(
                json!({"event_id": id(2), "installation_id": 5})
            )
            .is_err(),
            "a payload never carries what a webhook said"
        );
        assert!(serde_json::from_value::<GithubProcessEvent>(json!({"event_id": "x"})).is_err());
    }

    #[test]
    fn schemas_name_their_queue() {
        for (queue, schema) in [
            (
                GithubSyncInstallation::QUEUE,
                GithubSyncInstallation::SCHEMA,
            ),
            (GithubProcessEvent::QUEUE, GithubProcessEvent::SCHEMA),
            (GithubCheckRepository::QUEUE, GithubCheckRepository::SCHEMA),
            (GithubPlanBatch::QUEUE, GithubPlanBatch::SCHEMA),
            (CodeFixPatch::QUEUE, CodeFixPatch::SCHEMA),
            (GithubOpenPullRequest::QUEUE, GithubOpenPullRequest::SCHEMA),
            (GithubSyncPullRequest::QUEUE, GithubSyncPullRequest::SCHEMA),
        ] {
            assert!(schema.starts_with(&format!("{queue}@")), "{schema}");
        }
    }
}
