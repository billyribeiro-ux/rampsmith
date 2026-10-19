//! Installation tokens (PLAN §15 "Authentication", ADR-122).
//!
//! `POST /app/installations/{installation_id}/access_tokens`, checked on
//! <https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app>
//! on 2026-10-17: JWT bearer auth; optional `repository_ids` (up to 500) and `permissions`;
//! `201` with `token` and `expires_at`; tokens expire one hour after creation and may use a
//! variable-length format, so nothing here assumes a token length.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::error::GitHubError;
use crate::types::RepositoryId;

/// Refresh a cached token once it has less than this left. Each API call asks the cache for a
/// token, so the margin only has to outlast one call plus clock drift: the 30-second request
/// timeout, GitHub's recommended 60 seconds of drift tolerance, and room for the queue to
/// retry once. Five minutes covers that several times over and costs one extra token per hour
/// at most (ADR-122).
pub const TOKEN_REFRESH_SKEW: Duration = Duration::minutes(5);

/// The most repositories one token may be narrowed to, per GitHub's docs.
pub const MAX_TOKEN_REPOSITORIES: usize = 500;

/// A repository permission Rampsmith's App holds (PLAN §15). Workflows is deliberately absent:
/// a token can never be asked for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// Checks: the verification check run.
    Checks,
    /// Contents: read theme files; write fix branches and commits.
    Contents,
    /// Metadata: required by GitHub for every App.
    Metadata,
    /// Pull requests: open and update fix pull requests.
    PullRequests,
}

/// A permission level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Read.
    Read,
    /// Read and write.
    Write,
}

/// What a token is narrowed to. The default is everything the installation granted; narrowing
/// to one repository and the permissions a job needs is the least-privilege choice.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize)]
pub struct TokenScope {
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    repository_ids: BTreeSet<RepositoryId>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    permissions: BTreeMap<Permission, Access>,
}

impl TokenScope {
    /// Everything the installation granted.
    #[must_use]
    pub fn installation() -> Self {
        Self::default()
    }

    /// Adds a repository the token may access.
    #[must_use]
    pub fn repository(mut self, id: RepositoryId) -> Self {
        self.repository_ids.insert(id);
        self
    }

    /// Adds a permission.
    #[must_use]
    pub fn permission(mut self, permission: Permission, access: Access) -> Self {
        self.permissions.insert(permission, access);
        self
    }

    /// The scope for building and opening fix pull requests on one repository: contents,
    /// pull requests and checks write, metadata read.
    #[must_use]
    pub fn fix_pull_requests(repository: RepositoryId) -> Self {
        Self::default()
            .repository(repository)
            .permission(Permission::Contents, Access::Write)
            .permission(Permission::PullRequests, Access::Write)
            .permission(Permission::Checks, Access::Write)
            .permission(Permission::Metadata, Access::Read)
    }

    /// The scope for reading theme files on one repository.
    #[must_use]
    pub fn read_theme(repository: RepositoryId) -> Self {
        Self::default()
            .repository(repository)
            .permission(Permission::Contents, Access::Read)
            .permission(Permission::Metadata, Access::Read)
    }

    pub(crate) fn validate(&self) -> Result<(), GitHubError> {
        if self.repository_ids.len() > MAX_TOKEN_REPOSITORIES {
            return Err(GitHubError::InvalidRequest(
                "an installation token can be narrowed to at most 500 repositories",
            ));
        }
        Ok(())
    }
}

/// An installation token. It lives only in memory: it has no `Serialize`, its `Debug` shows
/// only the expiry, and the value never leaves this crate except as an `Authorization`
/// header marked sensitive.
pub struct InstallationToken {
    secret: SecretString,
    expires_at: OffsetDateTime,
}

impl InstallationToken {
    pub(crate) fn new(secret: SecretString, expires_at: OffsetDateTime) -> Self {
        Self { secret, expires_at }
    }

    /// When GitHub expires it.
    #[must_use]
    pub fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }

    /// Whether it is still worth using at `now`, with [`TOKEN_REFRESH_SKEW`] to spare.
    #[must_use]
    pub fn is_fresh(&self, now: OffsetDateTime) -> bool {
        now + TOKEN_REFRESH_SKEW < self.expires_at
    }

    pub(crate) fn bearer(&self) -> &str {
        self.secret.expose_secret()
    }
}

impl fmt::Debug for InstallationToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstallationToken")
            .field("expires_at", &self.expires_at)
            // `SecretString`'s own `Debug` prints `[REDACTED]`.
            .field("secret", &self.secret)
            .finish()
    }
}

/// The documented response fields Rampsmith uses. The token is moved into a `SecretString`
/// immediately after decoding.
#[derive(Deserialize)]
pub(crate) struct TokenResponse {
    pub(crate) token: String,
    pub(crate) expires_at: String,
}

impl TokenResponse {
    /// Moves the token into a secret and parses the RFC 3339 expiry.
    pub(crate) fn into_token(self) -> Result<InstallationToken, GitHubError> {
        let secret = SecretString::from(self.token);
        let expires_at = OffsetDateTime::parse(
            &self.expires_at,
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| {
            GitHubError::Decode(crate::error::DecodeError {
                category: "data",
                line: 0,
                column: 0,
            })
        })?;
        Ok(InstallationToken::new(secret, expires_at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_serializes_to_the_documented_body() {
        let scope = TokenScope::fix_pull_requests(RepositoryId::new(42));
        assert_eq!(
            serde_json::to_value(&scope).unwrap(),
            serde_json::json!({
                "repository_ids": [42],
                "permissions": {
                    "checks": "write",
                    "contents": "write",
                    "metadata": "read",
                    "pull_requests": "write"
                }
            })
        );
        assert_eq!(
            serde_json::to_value(TokenScope::installation()).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn a_token_can_never_request_workflows() {
        let all = [
            Permission::Checks,
            Permission::Contents,
            Permission::Metadata,
            Permission::PullRequests,
        ];
        for p in all {
            let name = serde_json::to_value(p).unwrap();
            assert_ne!(name, "workflows");
        }
    }

    #[test]
    fn scopes_over_five_hundred_repositories_are_refused() {
        let mut scope = TokenScope::installation();
        for id in 0..=500 {
            scope = scope.repository(RepositoryId::new(id));
        }
        assert!(scope.validate().is_err());
        assert!(
            TokenScope::read_theme(RepositoryId::new(1))
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn freshness_keeps_five_minutes_in_hand() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let token = InstallationToken::new(SecretString::from("t"), now + Duration::minutes(10));
        assert!(token.is_fresh(now));
        assert!(token.is_fresh(now + Duration::seconds(299)));
        assert!(!token.is_fresh(now + Duration::minutes(5)));
        assert!(!token.is_fresh(now + Duration::minutes(11)));
    }

    #[test]
    fn token_debug_is_redacted() {
        let token = InstallationToken::new(
            SecretString::from("ghs_VerySecretValue"),
            OffsetDateTime::UNIX_EPOCH,
        );
        let shown = format!("{token:?}");
        assert!(!shown.contains("ghs_"), "{shown}");
        assert!(shown.contains("REDACTED"));
    }

    // Autoref specialisation: `IsSerialize` applies without an extra borrow, so it wins
    // whenever the probed type implements `Serialize`; otherwise `NotSerialize` answers.
    struct Probe<T>(T);
    trait IsSerialize {
        fn serializable(&self) -> bool {
            true
        }
    }
    impl<T: Serialize> IsSerialize for Probe<T> {}
    trait NotSerialize {
        fn serializable(&self) -> bool {
            false
        }
    }
    impl<T> NotSerialize for &Probe<T> {}

    #[test]
    #[allow(clippy::needless_borrow)]
    fn installation_tokens_are_never_serializable() {
        let token = InstallationToken::new(SecretString::from("t"), OffsetDateTime::UNIX_EPOCH);
        assert!(!(&Probe(&token)).serializable());
        assert!(!(&Probe(&SecretString::from("t"))).serializable());
        assert!((&Probe(&TokenScope::installation())).serializable());
    }
}
