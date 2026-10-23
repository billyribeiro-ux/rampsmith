//! Installation state and the installer's identity, read from the GitHub API (ADR-290,
//! ADR-291; integration audit M1 and L7).
//!
//! Two things in the install flow are not to be believed from the request that carries them: the
//! `installation_id` that GitHub's redirect and a webhook name (a bad actor can send any id),
//! and the event that says an installation changed. So the id is confirmed with the installer's
//! own user access token (`GET /user/installations`, `GET /user/installations/{id}/repositories`),
//! and installation state is read back from the API (`GET /app/installations/{id}`,
//! `GET /installation/repositories`) rather than applied from a webhook body.
//!
//! Endpoints and fields, read in github/docs (`rest/apps/installations.md`, `rest/apps/apps.md`,
//! `apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app.md`)
//! on 23 Oct 2026:
//! - `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret` and
//!   `code` exchanges the code for a user access token (`ghu_`, 8 hours, scope always empty). A
//!   failed exchange answers HTTP 200 with an `error` member (`bad_verification_code`,
//!   `incorrect_client_credentials`, `redirect_uri_mismatch`, ...).
//! - `GET /user/installations` lists the App's installations the user can access, with `id`,
//!   `account`, `repository_selection`, `suspended_at`, `app_id` and `app_slug`.
//! - `GET /user/installations/{installation_id}/repositories` lists the repositories of that
//!   installation the user token can reach; each carries the user's `permissions`.
//! - `GET /app/installations/{installation_id}` (App JWT) answers 404 once uninstalled.
//! - `GET /installation/repositories` (installation token) lists the repositories the
//!   installation can access; `per_page` is at most 100.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;

use crate::types::{InstallationId, RepositoryId};
use crate::webhook::{Account, RepositorySelection};

/// The most pages read from a list endpoint (100 items each): a bound, not a promise that
/// 1,000 repositories are ever useful. A larger list is truncated and the caller is told.
pub const MAX_PAGES: u32 = 10;

/// The App's OAuth identity: the client id and secret that exchange a user authorization code.
pub struct OAuthApp {
    pub(crate) client_id: String,
    pub(crate) client_secret: SecretString,
}

impl OAuthApp {
    /// The App's client id (`GITHUB_APP_CLIENT_ID`) and client secret (`GITHUB_APP_CLIENT_SECRET`).
    #[must_use]
    pub fn new(client_id: &str, client_secret: SecretString) -> Self {
        Self {
            client_id: client_id.to_owned(),
            client_secret,
        }
    }
}

impl fmt::Debug for OAuthApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthApp")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

/// A user access token: proof that a person authorised the App and what they can reach. It is
/// used within the request that obtained it and then dropped; it has no `Serialize`, no
/// `Display` and a redacting `Debug`, and it is never stored (audit L7).
pub struct UserToken(SecretString);

impl UserToken {
    pub(crate) fn new(secret: SecretString) -> Self {
        Self(secret)
    }

    pub(crate) fn bearer(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for UserToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UserToken([REDACTED])")
    }
}

/// Why a code could not be exchanged. GitHub's own error names are kept; they carry no secret.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OAuthError {
    /// GitHub refused the code or the credentials (`bad_verification_code`,
    /// `incorrect_client_credentials`, `redirect_uri_mismatch`, ...).
    #[error("GitHub refused the authorization code ({0})")]
    Refused(String),
    /// The request failed or the answer was not understood.
    #[error(transparent)]
    Request(#[from] crate::error::GitHubError),
}

/// An installation, as the API describes it (`GET /app/installations/{id}` and the user's list).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InstallationInfo {
    /// Its id.
    pub id: InstallationId,
    /// The account it is installed on.
    pub account: Account,
    /// All or selected repositories.
    pub repository_selection: RepositorySelection,
    /// When it was suspended, if it is.
    #[serde(default)]
    pub suspended_at: Option<String>,
    /// The App's numeric id, which must be this App's.
    #[serde(default)]
    pub app_id: Option<u64>,
}

/// A repository an installation can reach.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InstalledRepository {
    /// Its id, which survives renames and transfers.
    pub id: RepositoryId,
    /// `owner/name` now.
    pub full_name: String,
    /// The default branch.
    #[serde(default)]
    pub default_branch: Option<String>,
    /// Whether it is private.
    #[serde(default)]
    pub private: bool,
    /// Whether it is archived (read only).
    #[serde(default)]
    pub archived: bool,
    /// The calling user's permissions, present on `GET /user/installations/{id}/repositories`.
    #[serde(default)]
    pub permissions: Option<UserPermissions>,
}

/// A user's permissions on a repository.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct UserPermissions {
    /// Administrator.
    #[serde(default)]
    pub admin: bool,
    /// Can push.
    #[serde(default)]
    pub push: bool,
}

/// A list read up to [`MAX_PAGES`] pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing<T> {
    /// The items read.
    pub items: Vec<T>,
    /// Whether more pages existed than were read.
    pub truncated: bool,
}

#[derive(Deserialize)]
pub(crate) struct TokenAnswer {
    #[serde(default)]
    pub(crate) access_token: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UserInstallations {
    pub(crate) installations: Vec<InstallationInfo>,
}

#[derive(Deserialize)]
pub(crate) struct RepositoriesPage {
    pub(crate) repositories: Vec<InstalledRepository>,
}

#[derive(Deserialize)]
pub(crate) struct UserLogin {
    pub(crate) login: String,
}

/// An OAuth error name is a short `snake_case` identifier; anything else is not echoed.
pub(crate) fn error_name(raw: &str) -> String {
    if (1..=64).contains(&raw.len())
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        raw.to_owned()
    } else {
        "unrecognised_error".to_owned()
    }
}
