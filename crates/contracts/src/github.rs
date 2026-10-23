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
            (GithubSyncInstallation::QUEUE, GithubSyncInstallation::SCHEMA),
            (GithubProcessEvent::QUEUE, GithubProcessEvent::SCHEMA),
            (GithubCheckRepository::QUEUE, GithubCheckRepository::SCHEMA),
        ] {
            assert!(schema.starts_with(&format!("{queue}@")), "{schema}");
        }
    }
}
