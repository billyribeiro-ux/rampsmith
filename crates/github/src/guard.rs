//! Pure guards on what Rampsmith may read and write in a merchant's repository (PLAN §15
//! "Boundaries", ADR-123).
//!
//! - [`ThemePath`]: the only path type the client reads or writes. It admits files directly
//!   inside Shopify's theme directories and rejects everything else, including `.env*`, key
//!   files, dotfiles, traversal, absolute, backslash and percent-encoded paths.
//! - [`check_theme_structure`]: confirms a branch holds a Shopify theme at its root.
//! - [`WritableBranch`]: the only branch type the client writes to; it must start with
//!   `rampsmith/` and can never be the branch connected to the live theme.
//!
//! Shopify's theme layout was checked on
//! <https://shopify.dev/docs/storefronts/themes/architecture> on 2026-10-17: the directories are
//! `assets`, `blocks`, `config`, `layout`, `locales`, `sections`, `snippets` and `templates`, the
//! only supported subdirectories are `templates/customers` and `templates/metaobject`, and only
//! `layout/theme.liquid` is required for upload.

use std::fmt;

use crate::types::BatchId;

/// The top-level directories of a Shopify theme.
pub const THEME_DIRECTORIES: [&str; 8] = [
    "assets",
    "blocks",
    "config",
    "layout",
    "locales",
    "sections",
    "snippets",
    "templates",
];

/// The only subdirectories Shopify supports, under `templates`.
pub const TEMPLATE_SUBDIRECTORIES: [&str; 2] = ["customers", "metaobject"];

/// Longest accepted path, in bytes.
pub const MAX_PATH_BYTES: usize = 256;

/// File extensions that hold keys, certificates or credential stores. Never read, never
/// written, whatever directory they sit in.
const KEY_EXTENSIONS: [&str; 14] = [
    "pem", "key", "p12", "pfx", "p8", "der", "crt", "cer", "csr", "jks", "keystore", "ppk", "gpg",
    "asc",
];

/// File names of SSH keys, with or without `.pub`.
const KEY_NAMES: [&str; 4] = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

/// Why a path was rejected. Messages name the rule, never the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PathRejection {
    /// Empty, or longer than [`MAX_PATH_BYTES`].
    #[error("the path is empty or too long")]
    Length,
    /// Starts with `/`.
    #[error("absolute paths are not allowed")]
    Absolute,
    /// Contains `\`.
    #[error("backslashes are not allowed in paths")]
    Backslash,
    /// Contains `%`, so it may be percent-encoded.
    #[error("percent-encoded paths are not allowed")]
    PercentEncoded,
    /// Contains a `.` or `..` segment.
    #[error("path traversal is not allowed")]
    Traversal,
    /// Contains an empty segment (`//` or a trailing `/`).
    #[error("empty path segments are not allowed")]
    EmptySegment,
    /// A segment starts with `.`.
    #[error("dotfiles are not allowed")]
    Dotfile,
    /// A character outside letters, digits, `.`, `_`, `-` and `/`.
    #[error("the path contains a character outside letters, digits, '.', '_', '-' and '/'")]
    Character,
    /// Not directly inside a theme directory or a supported template subdirectory.
    #[error("the path is outside the theme directories")]
    OutsideTheme,
    /// An environment file such as `production.env` or `x.env.local`.
    #[error("environment files are not allowed")]
    EnvFile,
    /// A key, certificate or credential-store file.
    #[error("key and certificate files are not allowed")]
    KeyFile,
}

/// A repository-relative path to a file inside a Shopify theme directory. Constructing one
/// is the allowlist check, so holding one is proof the path passed it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ThemePath(String);

impl ThemePath {
    /// Applies the read and write allowlist.
    pub fn parse(path: &str) -> Result<Self, PathRejection> {
        if path.is_empty() || path.len() > MAX_PATH_BYTES {
            return Err(PathRejection::Length);
        }
        if path.starts_with('/') {
            return Err(PathRejection::Absolute);
        }
        if path.contains('\\') {
            return Err(PathRejection::Backslash);
        }
        if path.contains('%') {
            return Err(PathRejection::PercentEncoded);
        }
        let segments: Vec<&str> = path.split('/').collect();
        for segment in &segments {
            match *segment {
                "" => return Err(PathRejection::EmptySegment),
                "." | ".." => return Err(PathRejection::Traversal),
                s if s.starts_with('.') => return Err(PathRejection::Dotfile),
                s if !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) =>
                {
                    return Err(PathRejection::Character);
                }
                _ => {}
            }
        }
        let inside = match segments.as_slice() {
            [dir, _file] => THEME_DIRECTORIES.contains(dir),
            ["templates", sub, _file] => TEMPLATE_SUBDIRECTORIES.contains(sub),
            _ => false,
        };
        if !inside {
            return Err(PathRejection::OutsideTheme);
        }
        // Compared in lowercase, so `.ENV` and `.PEM` are caught too.
        let file = segments.last().map_or("", |s| s).to_ascii_lowercase();
        let extension = file.rsplit_once('.').map(|(_, ext)| ext);
        if extension == Some("env") || file.contains(".env.") || file == "env" {
            return Err(PathRejection::EnvFile);
        }
        let stem = file.strip_suffix(".pub").unwrap_or(&file);
        if KEY_NAMES.contains(&stem) || extension.is_some_and(|ext| KEY_EXTENSIONS.contains(&ext)) {
            return Err(PathRejection::KeyFile);
        }
        Ok(Self(path.to_owned()))
    }

    /// The path.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ThemePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// One part of the default Shopify theme structure (PLAN §15 "Connecting a theme repository").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeRequirement {
    /// `layout/theme.liquid`, the one file Shopify requires.
    LayoutThemeLiquid,
    /// At least one file in `sections/`.
    Sections,
    /// At least one file in `templates/`.
    Templates,
    /// At least one file in `config/`.
    Config,
}

/// The branch does not hold a Shopify theme at its root.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the branch does not have the default Shopify theme structure; missing: {missing:?}")]
pub struct StructureError {
    /// What is missing, in a fixed order.
    pub missing: Vec<ThemeRequirement>,
}

/// Confirms `layout/theme.liquid`, `sections/`, `templates/` and `config/` exist at the root of
/// a repository file listing (paths of blobs, as a recursive tree listing returns them).
/// Git has no empty directories, so a directory exists when a file sits inside it.
pub fn check_theme_structure<'a, I>(files: I) -> Result<(), StructureError>
where
    I: IntoIterator<Item = &'a str>,
{
    let (mut layout, mut sections, mut templates, mut config) = (false, false, false, false);
    for file in files {
        layout |= file == "layout/theme.liquid";
        sections |= file.starts_with("sections/") && file.len() > "sections/".len();
        templates |= file.starts_with("templates/") && file.len() > "templates/".len();
        config |= file.starts_with("config/") && file.len() > "config/".len();
    }
    let missing: Vec<ThemeRequirement> = [
        (layout, ThemeRequirement::LayoutThemeLiquid),
        (sections, ThemeRequirement::Sections),
        (templates, ThemeRequirement::Templates),
        (config, ThemeRequirement::Config),
    ]
    .into_iter()
    .filter_map(|(present, requirement)| (!present).then_some(requirement))
    .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(StructureError { missing })
    }
}

/// The prefix of every branch Rampsmith writes.
pub const BRANCH_PREFIX: &str = "rampsmith/";

/// Longest accepted branch name, in bytes.
pub const MAX_BRANCH_BYTES: usize = 200;

/// Why a branch name was rejected for reading or writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BranchRejection {
    /// Not a branch name Git and GitHub accept, restricted further to URL-safe characters.
    #[error("not a valid branch name")]
    Invalid,
    /// Writes go only to branches under `rampsmith/`.
    #[error("Rampsmith writes only to branches under rampsmith/")]
    NotRampsmith,
    /// The branch connected to the live theme is never written.
    #[error("Rampsmith never writes to the branch connected to the live theme")]
    Connected,
}

/// A branch name accepted for reading: the `git check-ref-format` rules, limited to letters,
/// digits, `.`, `_`, `-` and `/` so it is safe in a URL path without encoding.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BranchName(String);

impl BranchName {
    /// Validates a branch name given without `refs/heads/`.
    pub fn parse(name: &str) -> Result<Self, BranchRejection> {
        let charset = name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'));
        let segments_ok = name.split('/').all(|s| {
            !s.is_empty()
                && !s.starts_with('.')
                && !s.starts_with('-')
                && s.rsplit_once('.').is_none_or(|(_, ext)| ext != "lock")
                && !s.ends_with('.')
        });
        let ok = (1..=MAX_BRANCH_BYTES).contains(&name.len())
            && charset
            && segments_ok
            && !name.contains("..")
            && !name.starts_with("refs/")
            && name != "HEAD";
        if ok {
            Ok(Self(name.to_owned()))
        } else {
            Err(BranchRejection::Invalid)
        }
    }

    /// The name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BranchName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A branch Rampsmith may write: under `rampsmith/`, and not the connected branch (compared
/// without regard to ASCII case, so a case-insensitive client cannot alias it).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WritableBranch(BranchName);

impl WritableBranch {
    /// Checks `name` against the branch connected to the live theme.
    pub fn new(name: &str, connected: &str) -> Result<Self, BranchRejection> {
        let branch = BranchName::parse(name)?;
        let suffix = name.strip_prefix(BRANCH_PREFIX).unwrap_or("");
        if suffix.is_empty() {
            return Err(BranchRejection::NotRampsmith);
        }
        if name.eq_ignore_ascii_case(connected.trim_start_matches("refs/heads/")) {
            return Err(BranchRejection::Connected);
        }
        Ok(Self(branch))
    }

    /// The fix branch for a batch, `rampsmith/fix-<batch id>`, with `-<part>` appended when a
    /// batch is split across several pull requests.
    pub fn for_batch(
        batch: &BatchId,
        part: Option<usize>,
        connected: &str,
    ) -> Result<Self, BranchRejection> {
        let name = match part {
            Some(part) => format!("{BRANCH_PREFIX}fix-{batch}-{part}"),
            None => format!("{BRANCH_PREFIX}fix-{batch}"),
        };
        Self::new(&name, connected)
    }

    /// The branch name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// As a readable branch name.
    #[must_use]
    pub fn as_branch(&self) -> &BranchName {
        &self.0
    }
}

impl fmt::Display for WritableBranch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a `rampsmith/` branch ref moves. Force is a separate, named variant so it is only ever
/// used deliberately: PLAN §15 "Re-derive, never rebase".
///
/// A re-derive replaces the branch only while it still points at the commit Rampsmith last
/// pushed to it (`expected_head`, stored with the pull request). If anyone else has pushed
/// since, for example a developer fixing up a commit, the update is refused instead of
/// discarding their work (integration audit L3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefUpdate {
    /// The new commit must descend from the current one.
    FastForward,
    /// The fix branch was rebuilt from a new base by re-running the recipes; replace it, but only
    /// while it still points at `expected_head`.
    Rederive {
        /// The head commit of Rampsmith's last push to this branch.
        expected_head: crate::types::Sha,
    },
}

impl RefUpdate {
    /// The `force` flag GitHub's update-a-reference endpoint takes.
    #[must_use]
    pub const fn force(&self) -> bool {
        matches!(self, Self::Rederive { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_paths_inside_theme_directories_are_allowed() {
        for ok in [
            "layout/theme.liquid",
            "sections/header.liquid",
            "snippets/icon-cart.liquid",
            "blocks/text.liquid",
            "templates/product.json",
            "templates/customers/login.json",
            "templates/metaobject/book.json",
            "config/settings_data.json",
            "locales/en.default.json",
            "locales/pt-BR.schema.json",
            "assets/base.css",
            "assets/global.js",
        ] {
            assert!(ThemePath::parse(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn env_files_are_rejected() {
        for bad in [".env", "config/.env", "assets/.env.production"] {
            assert_eq!(ThemePath::parse(bad), Err(PathRejection::Dotfile), "{bad}");
        }
        for bad in [
            "config/production.env",
            "assets/app.env.local",
            "config/env",
        ] {
            assert_eq!(ThemePath::parse(bad), Err(PathRejection::EnvFile), "{bad}");
        }
    }

    #[test]
    fn key_files_are_rejected() {
        for bad in [
            "assets/server.pem",
            "assets/private.KEY",
            "config/app.p12",
            "assets/github-app.private-key.pem",
            "snippets/id_rsa",
            "snippets/id_ed25519.pub",
            "assets/cert.crt",
            "assets/store.jks",
        ] {
            assert_eq!(ThemePath::parse(bad), Err(PathRejection::KeyFile), "{bad}");
        }
    }

    #[test]
    fn dotfiles_and_dot_directories_are_rejected() {
        for bad in [
            ".github/workflows/ci.yml",
            "assets/.htaccess",
            ".git/config",
            ".shopifyignore",
            "templates/.hidden/x.json",
        ] {
            assert_eq!(ThemePath::parse(bad), Err(PathRejection::Dotfile), "{bad}");
        }
    }

    #[test]
    fn traversal_absolute_backslash_and_percent_paths_are_rejected() {
        assert_eq!(
            ThemePath::parse("sections/../.env"),
            Err(PathRejection::Traversal)
        );
        assert_eq!(
            ThemePath::parse("sections/./a.liquid"),
            Err(PathRejection::Traversal)
        );
        assert_eq!(ThemePath::parse(".."), Err(PathRejection::Traversal));
        assert_eq!(
            ThemePath::parse("/layout/theme.liquid"),
            Err(PathRejection::Absolute)
        );
        assert_eq!(
            ThemePath::parse("sections\\header.liquid"),
            Err(PathRejection::Backslash)
        );
        assert_eq!(
            ThemePath::parse("sections/%2e%2e/x"),
            Err(PathRejection::PercentEncoded)
        );
        assert_eq!(
            ThemePath::parse("sections/a%20b.liquid"),
            Err(PathRejection::PercentEncoded)
        );
        assert_eq!(
            ThemePath::parse("sections//a.liquid"),
            Err(PathRejection::EmptySegment)
        );
        assert_eq!(
            ThemePath::parse("sections/"),
            Err(PathRejection::EmptySegment)
        );
    }

    #[test]
    fn paths_outside_theme_directories_are_rejected() {
        for bad in [
            "README.md",
            "package.json",
            "src/main.ts",
            "sections",
            "sections/nested/a.liquid",
            "templates/other/x.json",
            "layout/theme.liquid/extra",
            "Sections/header.liquid",
        ] {
            assert_eq!(
                ThemePath::parse(bad),
                Err(PathRejection::OutsideTheme),
                "{bad}"
            );
        }
    }

    #[test]
    fn unusual_characters_are_rejected() {
        for bad in [
            "sections/a b.liquid",
            "sections/a\0.liquid",
            "sections/a\n.liquid",
            "sections/caf\u{e9}.liquid",
            "sections/a?.liquid",
            "sections/a#b.liquid",
            "sections/a:b.liquid",
        ] {
            assert_eq!(
                ThemePath::parse(bad),
                Err(PathRejection::Character),
                "{bad:?}"
            );
        }
        assert_eq!(ThemePath::parse(""), Err(PathRejection::Length));
        let long = format!("assets/{}.css", "a".repeat(MAX_PATH_BYTES));
        assert_eq!(ThemePath::parse(&long), Err(PathRejection::Length));
    }

    #[test]
    fn rejection_messages_never_echo_the_path() {
        let err = ThemePath::parse("assets/super-secret-name.pem").unwrap_err();
        assert!(!err.to_string().contains("super-secret-name"));
    }

    #[test]
    fn theme_structure_accepts_a_default_theme() {
        let files = [
            "layout/theme.liquid",
            "sections/header.liquid",
            "templates/index.json",
            "config/settings_schema.json",
            "README.md",
        ];
        assert_eq!(check_theme_structure(files), Ok(()));
    }

    #[test]
    fn theme_structure_reports_every_missing_part_in_order() {
        let err = check_theme_structure(["layout/theme.liquid.bak", "sections"]).unwrap_err();
        assert_eq!(
            err.missing,
            vec![
                ThemeRequirement::LayoutThemeLiquid,
                ThemeRequirement::Sections,
                ThemeRequirement::Templates,
                ThemeRequirement::Config,
            ]
        );
        let err = check_theme_structure([
            "layout/theme.liquid",
            "sections/a.liquid",
            "templates/index.json",
        ])
        .unwrap_err();
        assert_eq!(err.missing, vec![ThemeRequirement::Config]);
    }

    #[test]
    fn theme_structure_requires_the_theme_at_the_root() {
        let nested = [
            "theme/layout/theme.liquid",
            "theme/sections/a.liquid",
            "theme/templates/index.json",
            "theme/config/settings_data.json",
        ];
        assert_eq!(check_theme_structure(nested).unwrap_err().missing.len(), 4);
    }

    #[test]
    fn writes_only_go_to_rampsmith_branches() {
        assert!(WritableBranch::new("rampsmith/fix-b1", "main").is_ok());
        assert!(WritableBranch::new("rampsmith/preview", "main").is_ok());
        assert_eq!(
            WritableBranch::new("rampsmith/", "main"),
            Err(BranchRejection::Invalid)
        );
        for bad in [
            "main",
            "feature/x",
            "rampsmithx/fix",
            "Rampsmith/fix",
            "rampsmith",
        ] {
            assert_eq!(
                WritableBranch::new(bad, "main"),
                Err(BranchRejection::NotRampsmith),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_connected_branch_is_never_writable() {
        assert_eq!(
            WritableBranch::new("rampsmith/live", "rampsmith/live"),
            Err(BranchRejection::Connected)
        );
        assert_eq!(
            WritableBranch::new("rampsmith/Live", "rampsmith/live"),
            Err(BranchRejection::Connected)
        );
        assert_eq!(
            WritableBranch::new("rampsmith/live", "refs/heads/rampsmith/live"),
            Err(BranchRejection::Connected)
        );
    }

    #[test]
    fn malformed_branch_names_are_rejected() {
        for bad in [
            "",
            "rampsmith/../main",
            "rampsmith//x",
            "rampsmith/x/",
            "rampsmith/.x",
            "rampsmith/-x",
            "rampsmith/x.lock",
            "rampsmith/x.",
            "rampsmith/x y",
            "rampsmith/x~1",
            "rampsmith/x^",
            "rampsmith/x:y",
            "rampsmith/x@{1}",
            "rampsmith/x%2f",
            "refs/heads/rampsmith/x",
            "HEAD",
        ] {
            assert!(BranchName::parse(bad).is_err(), "{bad:?}");
            assert!(WritableBranch::new(bad, "main").is_err(), "{bad:?}");
        }
        let long = format!("rampsmith/{}", "a".repeat(MAX_BRANCH_BYTES));
        assert_eq!(BranchName::parse(&long), Err(BranchRejection::Invalid));
    }

    #[test]
    fn batch_branches_are_named_from_the_batch_id() {
        let batch = BatchId::parse("0199f3a2").unwrap();
        assert_eq!(
            WritableBranch::for_batch(&batch, None, "main")
                .unwrap()
                .as_str(),
            "rampsmith/fix-0199f3a2"
        );
        assert_eq!(
            WritableBranch::for_batch(&batch, Some(2), "main")
                .unwrap()
                .as_str(),
            "rampsmith/fix-0199f3a2-2"
        );
    }

    #[test]
    fn only_rederive_forces_a_ref_update() {
        assert!(!RefUpdate::FastForward.force());
        assert!(
            RefUpdate::Rederive {
                expected_head: crate::types::Sha::parse(&"a".repeat(40)).unwrap()
            }
            .force()
        );
    }
}
