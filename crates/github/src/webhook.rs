//! Webhook deliveries: signature verification, the delivery id for deduplication, and typed
//! parsing of the four events Rampsmith uses (PLAN §15, §18; ADR-126).
//!
//! Checked on docs.github.com on 2026-10-17:
//! - <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>:
//!   `X-Hub-Signature-256` is `sha256=` plus the hex HMAC-SHA256 of the payload under the
//!   webhook secret; compare in constant time, never with `==`.
//! - <https://docs.github.com/en/webhooks/webhook-events-and-payloads>: `X-GitHub-Event` names
//!   the event; `X-GitHub-Delivery` is a GUID per delivery; payloads are capped at 25 MB;
//!   `installation` and `installation_repositories` reach every App by default; `push`
//!   carries at most 2048 commits; `installation` appears when the event is sent to an App.
//!
//! The signature is checked over the raw body before anything is parsed. Only the fields
//! Rampsmith needs are decoded; unknown fields and unknown actions are accepted, so a GitHub
//! addition never breaks intake.

use std::collections::BTreeSet;
use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use http::HeaderMap;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sha2::Sha256;

use crate::error::DecodeError;
use crate::types::{InstallationId, RepositoryId, Sha};

/// GitHub's payload cap; anything larger is refused before hashing.
pub const MAX_WEBHOOK_BYTES: usize = 25 * 1024 * 1024;

/// The signature header.
pub const SIGNATURE_HEADER: &str = "x-hub-signature-256";
/// The event name header.
pub const EVENT_HEADER: &str = "x-github-event";
/// The delivery id header.
pub const DELIVERY_HEADER: &str = "x-github-delivery";

/// Why a delivery was refused. Messages never contain the body, the secret or the signature.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    /// The webhook secret is empty.
    #[error("the webhook secret is empty")]
    EmptySecret,
    /// The body is over [`MAX_WEBHOOK_BYTES`].
    #[error("the webhook payload is larger than 25 MB")]
    PayloadTooLarge,
    /// A required header is absent.
    #[error("the {0} header is missing")]
    MissingHeader(&'static str),
    /// A header is present but malformed.
    #[error("the {0} header is malformed")]
    InvalidHeader(&'static str),
    /// The signature does not match the body under any configured secret.
    #[error("the webhook signature does not match")]
    SignatureMismatch,
    /// The body is not JSON.
    #[error("the webhook payload is not application/json")]
    UnsupportedContentType,
    /// The body is not the documented payload for its event.
    #[error("the webhook payload is invalid: {0}")]
    InvalidPayload(DecodeError),
}

/// Verifies deliveries against the current webhook secret and, during a rotation, the previous
/// one. Every configured secret is checked on every delivery, so timing does not reveal which
/// matched.
pub struct WebhookVerifier {
    secrets: Vec<SecretString>,
}

impl fmt::Debug for WebhookVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebhookVerifier")
            .field("secrets", &self.secrets.len())
            .finish()
    }
}

/// A delivery's GUID, for deduplication. Letters, digits and hyphens, at most 64 characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeliveryId(String);

impl DeliveryId {
    /// The id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DeliveryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A verified, parsed delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    /// The GUID to deduplicate on.
    pub id: DeliveryId,
    /// The event.
    pub event: Event,
}

/// The events Rampsmith handles; anything else is acknowledged by name and ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The App was installed, uninstalled, suspended or had permissions accepted.
    Installation(InstallationEvent),
    /// Repositories were added to or removed from an installation.
    InstallationRepositories(InstallationRepositoriesEvent),
    /// Pull request activity.
    PullRequest(PullRequestEvent),
    /// A push to a branch or tag.
    Push(PushEvent),
    /// Any other event, such as `ping`.
    Other {
        /// The `X-GitHub-Event` value.
        name: String,
    },
}

/// The installation a payload belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct InstallationRef {
    /// Its id.
    pub id: InstallationId,
}

/// The account an App is installed on. Enterprise accounts have no login or type.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Account {
    /// The account id.
    pub id: u64,
    /// The login, for users and organizations.
    pub login: Option<String>,
    /// `User` or `Organization`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

/// Whether an installation covers all repositories or a selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepositorySelection {
    /// Every repository of the account. Rampsmith never suggests it.
    All,
    /// Repositories the merchant picked.
    Selected,
}

/// The installation object in `installation` events.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Installation {
    /// Its id.
    pub id: InstallationId,
    /// The account.
    pub account: Account,
    /// All or selected repositories.
    pub repository_selection: RepositorySelection,
    /// When it was suspended, if it is.
    #[serde(default)]
    pub suspended_at: Option<String>,
}

/// A repository listed in installation events.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RepositorySummary {
    /// Its id.
    pub id: RepositoryId,
    /// `owner/name`; convert with [`crate::RepoRef::from_full_name`].
    pub full_name: String,
}

/// `installation` actions. Unknown actions parse as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationAction {
    /// Installed.
    Created,
    /// Uninstalled.
    Deleted,
    /// Suspended.
    Suspend,
    /// Unsuspended.
    Unsuspend,
    /// The account accepted new permissions.
    NewPermissionsAccepted,
    /// Anything else.
    #[serde(other)]
    Other,
}

/// The `installation` event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InstallationEvent {
    /// What happened.
    pub action: InstallationAction,
    /// The installation.
    pub installation: Installation,
    /// The repositories it can access, when GitHub lists them.
    #[serde(default)]
    pub repositories: Vec<RepositorySummary>,
}

/// `installation_repositories` actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationRepositoriesAction {
    /// Repositories were added.
    Added,
    /// Repositories were removed.
    Removed,
    /// Anything else.
    #[serde(other)]
    Other,
}

/// The `installation_repositories` event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InstallationRepositoriesEvent {
    /// What happened.
    pub action: InstallationRepositoriesAction,
    /// The installation.
    pub installation: InstallationRef,
    /// All or selected repositories, after the change.
    pub repository_selection: RepositorySelection,
    /// Added repositories.
    pub repositories_added: Vec<RepositorySummary>,
    /// Removed repositories.
    pub repositories_removed: Vec<RepositorySummary>,
}

/// The repository a `pull_request` or `push` event happened in.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RepositoryInfo {
    /// Its id.
    pub id: RepositoryId,
    /// `owner/name`.
    pub full_name: String,
}

/// A pull request's head or base.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitRefInfo {
    /// The branch name.
    #[serde(rename = "ref")]
    pub reference: String,
    /// The commit.
    pub sha: Sha,
}

/// The pull request fields Rampsmith reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PullRequestInfo {
    /// The global id.
    pub id: u64,
    /// The number.
    pub number: u64,
    /// `open` or `closed`.
    pub state: String,
    /// Whether it was merged; set on `closed`.
    #[serde(default)]
    pub merged: Option<bool>,
    /// The head branch and commit.
    pub head: GitRefInfo,
    /// The base branch and commit.
    pub base: GitRefInfo,
}

/// `pull_request` actions Rampsmith acts on; the other documented actions parse as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestAction {
    /// Opened.
    Opened,
    /// Closed, merged or not.
    Closed,
    /// Reopened.
    Reopened,
    /// New commits on the head branch.
    Synchronize,
    /// Title, body or base edited.
    Edited,
    /// Anything else.
    #[serde(other)]
    Other,
}

/// The `pull_request` event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PullRequestEvent {
    /// What happened.
    pub action: PullRequestAction,
    /// The number.
    pub number: u64,
    /// The pull request.
    pub pull_request: PullRequestInfo,
    /// The repository.
    pub repository: RepositoryInfo,
    /// The installation, present on App deliveries.
    #[serde(default)]
    pub installation: Option<InstallationRef>,
}

/// A commit in a `push` event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PushCommit {
    /// The commit.
    pub id: Sha,
    /// Added paths.
    #[serde(default)]
    pub added: Vec<String>,
    /// Removed paths.
    #[serde(default)]
    pub removed: Vec<String>,
    /// Modified paths.
    #[serde(default)]
    pub modified: Vec<String>,
}

/// The `push` event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PushEvent {
    /// The full ref, such as `refs/heads/main`.
    #[serde(rename = "ref")]
    pub reference: String,
    /// The ref's commit before the push (all zeros when created).
    pub before: Sha,
    /// The ref's commit after the push (all zeros when deleted).
    pub after: Sha,
    /// Whether the push created the ref.
    pub created: bool,
    /// Whether the push deleted the ref.
    pub deleted: bool,
    /// Whether it was a force push.
    pub forced: bool,
    /// The repository.
    pub repository: RepositoryInfo,
    /// The installation, present on App deliveries.
    #[serde(default)]
    pub installation: Option<InstallationRef>,
    /// Up to 2048 pushed commits.
    #[serde(default)]
    pub commits: Vec<PushCommit>,
}

impl PushEvent {
    /// The branch name when the ref is a branch.
    #[must_use]
    pub fn branch(&self) -> Option<&str> {
        self.reference.strip_prefix("refs/heads/")
    }

    /// Every path the pushed commits added, modified or removed, sorted and deduplicated.
    #[must_use]
    pub fn changed_paths(&self) -> BTreeSet<&str> {
        self.commits
            .iter()
            .flat_map(|c| c.added.iter().chain(&c.modified).chain(&c.removed))
            .map(String::as_str)
            .collect()
    }
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `sha256=` followed by exactly 64 hex digits, decoded.
fn decode_signature(value: &[u8]) -> Option<[u8; 32]> {
    let hex = value.strip_prefix(b"sha256=")?;
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0_u8; 32];
    for (slot, pair) in out.iter_mut().zip(hex.chunks_exact(2)) {
        let [high, low] = pair else { return None };
        *slot = (hex_value(*high)? << 4) | hex_value(*low)?;
    }
    Some(out)
}

fn header<'h>(headers: &'h HeaderMap, name: &'static str) -> Result<&'h str, WebhookError> {
    headers
        .get(name)
        .ok_or(WebhookError::MissingHeader(name))?
        .to_str()
        .map_err(|_| WebhookError::InvalidHeader(name))
}

fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, WebhookError> {
    serde_json::from_slice(body).map_err(|e| WebhookError::InvalidPayload(DecodeError::from(&e)))
}

impl WebhookVerifier {
    /// Verifies with one secret.
    pub fn new(secret: SecretString) -> Result<Self, WebhookError> {
        if secret.expose_secret().is_empty() {
            return Err(WebhookError::EmptySecret);
        }
        Ok(Self {
            secrets: vec![secret],
        })
    }

    /// Also accepts the previous secret, for the overlap window of a rotation.
    pub fn with_previous(mut self, previous: SecretString) -> Result<Self, WebhookError> {
        if previous.expose_secret().is_empty() {
            return Err(WebhookError::EmptySecret);
        }
        self.secrets.push(previous);
        Ok(self)
    }

    /// Checks an `X-Hub-Signature-256` value against the raw body, in constant time per secret.
    pub fn verify(&self, signature: &[u8], body: &[u8]) -> Result<(), WebhookError> {
        if body.len() > MAX_WEBHOOK_BYTES {
            return Err(WebhookError::PayloadTooLarge);
        }
        let expected =
            decode_signature(signature).ok_or(WebhookError::InvalidHeader(SIGNATURE_HEADER))?;
        let mut matched = false;
        for secret in &self.secrets {
            let mut mac =
                <Hmac<Sha256> as KeyInit>::new_from_slice(secret.expose_secret().as_bytes())
                    .map_err(|_| WebhookError::SignatureMismatch)?;
            mac.update(body);
            // `verify_slice` compares with `subtle`'s constant-time equality.
            matched |= mac.verify_slice(&expected).is_ok();
        }
        if matched {
            Ok(())
        } else {
            Err(WebhookError::SignatureMismatch)
        }
    }

    /// Verifies the signature over the raw body, then reads the delivery id and parses the
    /// event. Nothing in the body is looked at before the signature passes.
    pub fn verify_and_parse(
        &self,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Delivery, WebhookError> {
        if body.len() > MAX_WEBHOOK_BYTES {
            return Err(WebhookError::PayloadTooLarge);
        }
        let signature = headers
            .get(SIGNATURE_HEADER)
            .ok_or(WebhookError::MissingHeader(SIGNATURE_HEADER))?;
        self.verify(signature.as_bytes(), body)?;

        let id = header(headers, DELIVERY_HEADER)?;
        let id_ok = (1..=64).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !id_ok {
            return Err(WebhookError::InvalidHeader(DELIVERY_HEADER));
        }
        let name = header(headers, EVENT_HEADER)?;
        let name_ok = (1..=64).contains(&name.len())
            && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if !name_ok {
            return Err(WebhookError::InvalidHeader(EVENT_HEADER));
        }
        if let Some(content_type) = headers.get(http::header::CONTENT_TYPE) {
            let media = content_type
                .to_str()
                .map_err(|_| WebhookError::UnsupportedContentType)?
                .split(';')
                .next()
                .unwrap_or("")
                .trim();
            if !media.eq_ignore_ascii_case("application/json") {
                return Err(WebhookError::UnsupportedContentType);
            }
        }
        let event = match name {
            "installation" => Event::Installation(parse(body)?),
            "installation_repositories" => Event::InstallationRepositories(parse(body)?),
            "pull_request" => Event::PullRequest(parse(body)?),
            "push" => Event::Push(parse(body)?),
            other => Event::Other {
                name: other.to_owned(),
            },
        };
        Ok(Delivery {
            id: DeliveryId(id.to_owned()),
            event,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn githubs_documented_test_vector_verifies() {
        // From the validating-webhook-deliveries page.
        let verifier =
            WebhookVerifier::new(SecretString::from("It's a Secret to Everybody")).unwrap();
        let header = b"sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert_eq!(verifier.verify(header, b"Hello, World!"), Ok(()));
        assert_eq!(
            verifier.verify(header, b"Hello, World?"),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn uppercase_hex_is_accepted_and_malformed_signatures_are_refused() {
        let verifier =
            WebhookVerifier::new(SecretString::from("It's a Secret to Everybody")).unwrap();
        let upper = b"sha256=757107EA0EB2509FC211221CCE984B8A37570B6D7586C22C46F4379C8B043E17";
        assert_eq!(verifier.verify(upper, b"Hello, World!"), Ok(()));
        for bad in [
            &b"757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"[..],
            b"sha1=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
            b"sha256=757107ea",
            b"sha256=zz7107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
            b"sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e1700",
            b"",
        ] {
            assert_eq!(
                verifier.verify(bad, b"Hello, World!"),
                Err(WebhookError::InvalidHeader(SIGNATURE_HEADER))
            );
        }
    }

    #[test]
    fn empty_secrets_are_refused() {
        assert!(matches!(
            WebhookVerifier::new(SecretString::from("")),
            Err(WebhookError::EmptySecret)
        ));
    }

    #[test]
    fn verifier_debug_hides_secrets() {
        let verifier = WebhookVerifier::new(SecretString::from("whsec-value"))
            .unwrap()
            .with_previous(SecretString::from("old-value"))
            .unwrap();
        let shown = format!("{verifier:?}");
        assert!(!shown.contains("whsec-value") && !shown.contains("old-value"));
    }

    #[test]
    fn oversized_payloads_are_refused_before_hashing() {
        let verifier = WebhookVerifier::new(SecretString::from("s")).unwrap();
        let body = vec![b' '; MAX_WEBHOOK_BYTES + 1];
        assert_eq!(
            verifier.verify(b"sha256=00", &body),
            Err(WebhookError::PayloadTooLarge)
        );
    }

    #[test]
    fn push_helpers_report_branch_and_paths() {
        let zero = Sha::parse(&"0".repeat(40)).unwrap();
        let push = PushEvent {
            reference: "refs/heads/main".to_owned(),
            before: zero.clone(),
            after: zero.clone(),
            created: false,
            deleted: false,
            forced: false,
            repository: RepositoryInfo {
                id: RepositoryId::new(1),
                full_name: "o/r".to_owned(),
            },
            installation: None,
            commits: vec![
                PushCommit {
                    id: zero.clone(),
                    added: vec!["sections/b.liquid".to_owned()],
                    removed: vec![],
                    modified: vec!["sections/a.liquid".to_owned()],
                },
                PushCommit {
                    id: zero,
                    added: vec![],
                    removed: vec!["sections/a.liquid".to_owned()],
                    modified: vec![],
                },
            ],
        };
        assert_eq!(push.branch(), Some("main"));
        assert_eq!(
            push.changed_paths().into_iter().collect::<Vec<_>>(),
            ["sections/a.liquid", "sections/b.liquid"]
        );
    }
}
