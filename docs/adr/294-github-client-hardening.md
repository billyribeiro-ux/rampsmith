# ADR-294: The GitHub client's guards for the audit findings

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-126, ADR-127, integration audit findings M2, L2, L3, L8, L9

## Context

`crates/github` writes to repositories that belong to merchants. The integration audit found
places where untrusted text, concurrency or leftover state could do harm.

## Decision

- **M2, no finding text in a commit message.** A commit message is
  `fix(a11y): <summary> [WCAG <criterion>]` plus a `Rampsmith-Fix: <id>` trailer. The summary
  comes from Rampsmith's own recipe catalogue and is checked against an allow-list (letters, digits,
  space and `- _ . , ' ( ) / &`); anything else is refused, not sanitised. Text taken from a
  storefront or a finding appears only in the pull request body, inside code spans.
- **L2, one token mint per installation and scope.** The token cache has one slot per key with its
  own lock, so concurrent callers share a single mint and a slow mint for one installation does not
  delay another.
- **L3, force-push only over our own push.** A re-derive updates the branch with `force` only when
  the current head equals `expected_head`, the sha Rampsmith last pushed. If the merchant added a
  commit, the update is refused with `branch_moved` and the branch is left as it is. A first push is
  never forced.
- **L8, match by repository id and number.** See ADR-293.
- **L9, narrow scopes and no leftover key material.** `TokenScope::installation()` (every
  repository, every permission) is crate-private; callers can ask only for the read-metadata,
  read-theme and fix-pull-request scopes, each narrowed to one repository. The private key's PEM
  and decoded DER are wiped after parsing; `ctl` parses the key at boot and keeps only the parsed
  credentials, which move into the client. The environment variable itself stays in the process
  environment, and the HTTP stack's copy of a request body (the OAuth exchange) cannot be wiped by
  the client; both are documented limits.

## Consequences

Tests in `crates/github/src/pr.rs`, `guard.rs`, `crates/github/tests/client.rs` and `install.rs`.
