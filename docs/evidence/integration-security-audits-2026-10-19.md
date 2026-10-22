# Security audits owed by the stream integration (19 Oct 2026)

The twelve stream branches merged into `main` as `ae00e4d` (PR #18) on the founder's instruction
of 19 October 2026, 19:04 UTC, with their owed `security-auditor` runs moved to right after the
merge. Both ran at effort max on `origin/main` at `ce933a7`.

## GitHub App (`crates/github`, `infra/github-app-manifest.json`) and billing (`crates/billing`): PASS

No critical or high; 3 medium, 9 low. Tests: github 139 passed, billing 106 passed (rustc 1.97).
Neither crate is called by `api` or `ctl` yet, so each medium is fixed before the code that uses it
is built.

| # | Finding | Owner |
| --- | --- | --- |
| M1 | Webhook dedup keys on the unsigned `X-GitHub-Delivery`; a captured delivery replays with a new id. Store a SHA-256 of the raw body with a unique constraint; read installation state from the API instead of applying the event. Same for `X-Shopify-Event-Id`. | Webhook route (R1) |
| M2 | Untrusted finding text reaches commit messages with `[skip ci]`, closing keywords and mentions intact; `lib.rs` claims otherwise. Leave finding text out of commit messages. | GitHub channel (R2) |
| M3 | Any shop can drain the shared Partner API limit (forced calls for any `plan_handle`, and on every load without a plan). Per-shop rate, never call for unrecognised handles, fair share per tenant. | Billing wiring (R1) |
| L1–L9 | Sweep date overflow panics; one token request blocks all installations; re-derive force-push can drop a developer's commits; billing errors echo raw input; **L5 entitlements contradicted ADR-141 (fixed, PR #20)**; resubscribe restarts the allowance; `GITHUB_APP_CLIENT_SECRET` missing from LAUNCH.md C row 4 and Railway; pull requests not matched by repository id; private-key copies and a public all-repository token scope. | As listed in the report |

## `rsctl` (W1) and backup and restore ops (W2): FAIL

2 high, 3 medium, 11 low. Nothing is exploitable today because no founder secret exists; both highs
must be fixed **before the founder adds any input**.

| # | Finding |
| --- | --- |
| H1 | Backup and drill credentials fall back to repository secrets (FOUNDER_SETUP sends R2 keys to "Both" and the workspace `RAILWAY_API_TOKEN` to GitHub), so any workflow on any branch of this public repository can read them; the nightly and weekly schedules auto-create `backup-*` environments without protection. Fix: backup-only secret names set only as environment secrets, the `scope` job from `deploy.yml`, a protection check, and LAUNCH.md C / FOUNDER_SETUP rows. |
| H2 | The default `railway-ssh` transport gives an unattended nightly job a workspace token and SSH key; the dump crosses SSH in plaintext and no host key is pinned. Fix: the in-project Railway cron service with the `url` transport (ADR-174); keep backups skipped until it exists. |
| M1 | One R2 token for both buckets: `rsctl doctor --strict` pushes the founder to give the engine's token the backups bucket. Two tokens, and a negative check. |
| M2 | Restore trusts the newest object in the bucket (far-future keys win forever) and a dump can run code of its maker's choosing. Anchor integrity outside the bucket, reject future timestamps, inspect the archive before restoring. |
| M3 | The live restore drill cannot read its own inputs (0700 dirs, container uid 999), so the weekly real restore never runs. |
| L1–L11 | Zeroization gaps; a false runbook PASS for `doctor --row 4`; restore checks narrower than documented; a secret typed on an `export` line; the backup role can read `pg_authid`; inconsistent default transport; an unvalidated prune cap; a public drill artifact with tenant ids; clap echoing arguments; `permissions: read-all`; the drill recipient usable in production. |

Full reports are in the architect chat's transcript (session `session_01Xo2TExfkKEuqRyHUMqc1YC`).
