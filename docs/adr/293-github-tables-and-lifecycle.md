# ADR-293: The GitHub tables, their isolation and their lifecycle

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-006, ADR-017, ADR-089

## Context

The channel adds state that belongs to a store: which GitHub installation, which repository, which
pull requests, and the deliveries received.

## Decision

Migration `20261111000001_github_channel.sql` adds `github_install_states`,
`github_installations`, `github_repos`, `github_pull_requests`, `github_pr_fixes` and
`github_events`. Each has `tenant_id`, row-level security on `app_current_tenant()`, composite
foreign keys (`(x_id, tenant_id)`), and is in the tenancy suite (`TENANT_TABLES` and `R1_TABLES`
of `crates/db/tests/tenancy.rs`, seeded one row per tenant) and in the restore drill's seed.

- Pull requests are identified by `(tenant_id, repo_id, number)`, GitHub's repository id and the
  number, never by a name or a branch (audit L8). `(tenant_id, batch_id, part)` is unique.
- `github_pull_requests.pushed_sha` is the head Rampsmith last pushed; a re-derive may force the
  branch only while GitHub's head equals it (ADR-294).
- Two security-definer functions exist for lookups that start before the tenant is known:
  `app_github_consume_state` and `app_github_installation`. Both return the minimum (a tenant and a
  row) and are executable by the application roles only. `github_events_sweep` is for the worker.
- The application role may insert and update; only the worker may delete, which `shop/redact`
  and the sweep need.
- `app/uninstalled` (and the operator path) ends the link and cancels the channel's jobs.
  `shop/redact` deletes every row of these tables for the tenant, before the fixes they point at.
  The merchant's repository and the App's installation on GitHub are theirs and are not touched.

## Consequences

Every query goes through `TenantTx`; `crates/db/tests/github.rs` covers the repository functions
and the redaction. A store has at most one live installation and one chosen repository.
