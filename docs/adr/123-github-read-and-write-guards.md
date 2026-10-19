# ADR-123: What Rampsmith may read and write in a theme repository

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

PLAN §15 "Boundaries": file reads are limited to theme directories; `.env*`, key files and
anything outside the theme tree are never read; Rampsmith never merges, never pushes to a
protected branch and never touches a branch it did not create. "Connecting a theme
repository" asks to confirm `layout/theme.liquid`, `sections/`, `templates/` and `config/`.
ADR-004 forbids writing theme files through Shopify's APIs; the pull request is the channel.

Checked on 2026-10-17:

- [Shopify theme architecture](https://shopify.dev/docs/storefronts/themes/architecture):
  directories `assets`, `blocks`, `config`, `layout`, `locales`, `sections`, `snippets`,
  `templates`, with `templates/customers` and `templates/metaobject`; "Subdirectories, other than
  the ones listed, aren't supported"; only `layout/theme.liquid` is required to upload.
- [Shopify GitHub integration](https://shopify.dev/docs/storefronts/themes/tools/github): only
  branches matching the default theme structure can be connected; other folders are ignored.
- [Get a tree](https://docs.github.com/en/rest/git/trees#get-a-tree): symlinks are blobs with
  mode `120000`. The contents API follows symlinks to their target, so reading by path could
  escape the theme directories.

## Decision

1. **`ThemePath` is the only path type the client reads or writes.** Constructing one is the
   allowlist check: one of the eight theme directories plus a file name, or
   `templates/customers/` or `templates/metaobject/` plus a file name; segments of ASCII letters,
   digits, `.`, `_`, `-`; at most 256 bytes. Rejected, each with its own reason and a test:
   absolute paths, backslashes, any `%` (percent-encoding), `.` and `..` segments, empty
   segments, any segment starting with `.` (dotfiles, `.env`, `.github`), environment files
   (`*.env`, `*.env.*`), key and certificate files (`pem`, `key`, `p12`, `pfx`, `p8`, `der`,
   `crt`, `cer`, `csr`, `jks`, `keystore`, `ppk`, `gpg`, `asc`, SSH key names), compared without
   regard to case. Rejection messages never echo the path.
2. **Reads go through the tree, never by path.** `Repository::tree` lists a commit
   recursively; only blobs with mode `100644` or `100755` whose path is a `ThemePath` become a
   `ThemeFile`, and `read_theme_file` takes only a `ThemeFile` and fetches its blob by SHA.
   `ThemeFile`'s fields are private, so callers cannot pair a theme path with another blob. A
   symlink in `snippets/` pointing at `../.env` is never read. A truncated listing is an error.
3. **Theme structure.** `check_theme_structure` requires `layout/theme.liquid` and at least one
   file in `sections/`, `templates/` and `config/` at the repository root (Git has no empty
   directories), and reports every missing part in a fixed order. This is stricter than
   Shopify's upload rule on purpose: mapping (PLAN §12) needs sections, templates and settings.
4. **Writes.** Tree entries are `ThemePath`s, so a fix can never create `.github/workflows/*`
   or touch anything outside the theme. `WritableBranch` is the only branch type the client
   writes: it must start with `rampsmith/`, pass `git check-ref-format` rules restricted to
   URL-safe characters, and differ from the connected branch without regard to ASCII case.
   `open_or_update_pull_request` re-checks the head against the base it is given.
5. **Force.** `RefUpdate::FastForward` sends `force: false`; only `RefUpdate::Rederive` sends
   `force: true`, for PLAN §15 "Re-derive, never rebase". The crate has no merge call.

## Consequences

- Theme files whose names use other characters (spaces, accents) are skipped for reading and
  cannot be patched. Shopify's own themes use none; widening the set is a one-line change with
  the same tests.
- Whether a `rampsmith/` branch was created by Rampsmith is a storage question for the `db`
  and job owners; this crate enforces the prefix and the connected-branch exclusion.

## Rejected alternatives

- A denylist over arbitrary paths: every new secret-file convention would be a hole.
- Reading through the contents API by path: follows symlinks out of the theme.
