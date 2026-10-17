//! Identifiers shared by the client, the webhook parser and the pull-request builder. Each one
//! is validated on construction, so a value that reaches a URL path is always URL-safe.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Why an identifier was rejected. Messages name the rule, never the rejected value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// Not a 40- or 64-digit lowercase hexadecimal object id.
    #[error("not a Git object id")]
    Sha,
    /// Not a GitHub account login.
    #[error("not a GitHub account login")]
    Owner,
    /// Not a GitHub repository name.
    #[error("not a GitHub repository name")]
    RepoName,
    /// Not an `owner/name` pair.
    #[error("not an owner/name repository reference")]
    FullName,
    /// Not a Rampsmith id (1 to 64 ASCII letters, digits or hyphens).
    #[error("not a Rampsmith id: 1 to 64 ASCII letters, digits or hyphens")]
    RampsmithId,
    /// Not a WCAG success criterion such as `2.4.4`.
    #[error("not a WCAG success criterion such as 2.4.4")]
    Criterion,
}

/// A GitHub App installation id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InstallationId(u64);

impl InstallationId {
    /// Wraps a numeric installation id.
    #[must_use]
    pub const fn new(id: u64) -> Self {
        Self(id)
    }

    /// The numeric id.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for InstallationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A GitHub repository id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RepositoryId(u64);

impl RepositoryId {
    /// Wraps a numeric repository id.
    #[must_use]
    pub const fn new(id: u64) -> Self {
        Self(id)
    }

    /// The numeric id.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// A check run id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CheckRunId(u64);

impl CheckRunId {
    /// Wraps a numeric check run id.
    #[must_use]
    pub const fn new(id: u64) -> Self {
        Self(id)
    }

    /// The numeric id.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// A Git object id: 40 lowercase hex digits (SHA-1), or 64 for SHA-256 repositories.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha(String);

impl Sha {
    /// Parses an object id.
    pub fn parse(value: &str) -> Result<Self, IdError> {
        let hex = value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if hex && (value.len() == 40 || value.len() == 64) {
            Ok(Self(value.to_owned()))
        } else {
            Err(IdError::Sha)
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Sha {
    type Error = IdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<Sha> for String {
    fn from(sha: Sha) -> Self {
        sha.0
    }
}

impl fmt::Display for Sha {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A repository addressed by owner and name, both restricted to the characters GitHub allows,
/// so they are safe to place in a URL path without encoding.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepoRef {
    owner: String,
    name: String,
}

impl RepoRef {
    /// Validates an owner login (letters, digits, hyphens and, for managed users, underscores;
    /// at most 39 characters) and a repository name (letters, digits, `.`, `_`, `-`; at most
    /// 100 characters; not `.` or `..`).
    pub fn new(owner: &str, name: &str) -> Result<Self, IdError> {
        let owner_ok = (1..=39).contains(&owner.len())
            && owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && !owner.starts_with('-');
        if !owner_ok {
            return Err(IdError::Owner);
        }
        let name_ok = (1..=100).contains(&name.len())
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            && name != "."
            && name != "..";
        if !name_ok {
            return Err(IdError::RepoName);
        }
        Ok(Self {
            owner: owner.to_owned(),
            name: name.to_owned(),
        })
    }

    /// Parses `owner/name`.
    pub fn from_full_name(full_name: &str) -> Result<Self, IdError> {
        let (owner, name) = full_name.split_once('/').ok_or(IdError::FullName)?;
        Self::new(owner, name)
    }

    /// The owner login.
    #[must_use]
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// The repository name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl fmt::Display for RepoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.owner, self.name)
    }
}

fn is_rampsmith_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A Rampsmith fix id, carried in the `Rampsmith-Fix` commit trailer.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FixId(String);

impl FixId {
    /// Validates a fix id: 1 to 64 ASCII letters, digits or hyphens (a UUID fits).
    pub fn parse(value: &str) -> Result<Self, IdError> {
        if is_rampsmith_id(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(IdError::RampsmithId)
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FixId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Rampsmith fix batch id, which names the head branch `rampsmith/fix-<batch id>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BatchId(String);

impl BatchId {
    /// Validates a batch id: 1 to 64 ASCII letters, digits or hyphens (a UUID fits).
    pub fn parse(value: &str) -> Result<Self, IdError> {
        if is_rampsmith_id(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(IdError::RampsmithId)
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BatchId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A WCAG success criterion number, such as `2.4.4` or `1.4.3`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WcagCriterion(String);

impl WcagCriterion {
    /// Validates `principle.guideline.criterion`: one digit 1 to 4, then one or two digits,
    /// then one or two digits.
    pub fn parse(value: &str) -> Result<Self, IdError> {
        let parts: Vec<&str> = value.split('.').collect();
        let digits = |s: &str, max: usize| {
            (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
        };
        let ok = matches!(parts.as_slice(), [p, g, c]
            if matches!(*p, "1" | "2" | "3" | "4") && digits(g, 2) && digits(c, 2));
        if ok {
            Ok(Self(value.to_owned()))
        } else {
            Err(IdError::Criterion)
        }
    }

    /// The criterion number.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WcagCriterion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha_accepts_sha1_and_sha256_lowercase_hex_only() {
        assert!(Sha::parse(&"a".repeat(40)).is_ok());
        assert!(Sha::parse(&"0".repeat(64)).is_ok());
        assert_eq!(Sha::parse(&"A".repeat(40)), Err(IdError::Sha));
        assert_eq!(Sha::parse(&"a".repeat(39)), Err(IdError::Sha));
        assert_eq!(
            Sha::parse(&format!("{}/", "a".repeat(39))),
            Err(IdError::Sha)
        );
        assert_eq!(Sha::parse(""), Err(IdError::Sha));
    }

    #[test]
    fn repo_ref_rejects_path_characters() {
        assert!(RepoRef::new("octo-org", "dawn.theme_2").is_ok());
        assert!(RepoRef::new("emu_user", "repo").is_ok());
        for (owner, name) in [
            ("", "r"),
            ("-lead", "r"),
            ("a/b", "r"),
            ("o", ""),
            ("o", ".."),
            ("o", "."),
            ("o", "r/../x"),
            ("o", "r%2f"),
            ("o", "r?x"),
            ("o w", "r"),
        ] {
            assert!(RepoRef::new(owner, name).is_err(), "{owner}/{name}");
        }
        assert_eq!(
            RepoRef::from_full_name("octo/dawn").unwrap().to_string(),
            "octo/dawn"
        );
        assert_eq!(RepoRef::from_full_name("octo"), Err(IdError::FullName));
        assert_eq!(RepoRef::from_full_name("a/b/c"), Err(IdError::RepoName));
    }

    #[test]
    fn rampsmith_ids_allow_uuids_only_charset() {
        assert!(FixId::parse("0199f3a2-7c1e-7d4b-9a10-5f2b8c3d4e5f").is_ok());
        assert!(BatchId::parse("b1").is_ok());
        let long = "x".repeat(65);
        for bad in ["", "a b", "a\nRampsmith-Fix: x", "a/b", long.as_str()] {
            assert!(FixId::parse(bad).is_err(), "{bad:?}");
            assert!(BatchId::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn wcag_criterion_format() {
        for ok in ["2.4.4", "1.4.3", "2.5.8", "4.1.2", "1.4.11"] {
            assert!(WcagCriterion::parse(ok).is_ok(), "{ok}");
        }
        for bad in ["", "2.4", "5.1.1", "2.4.4.1", "2.a.4", "2.4.123", "2.4.4]"] {
            assert!(WcagCriterion::parse(bad).is_err(), "{bad}");
        }
    }
}
