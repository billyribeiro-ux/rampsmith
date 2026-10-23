# R2 GitHub channel, part 1: installation flow, tables, webhook (PR1)

Scope: ADR-290 to ADR-294. The patch pipeline (PR2) and the App Home screen (PR3) add their own
sections below as they land.

## Commands run (Rust 1.97 stable, Postgres 18, private instance)

| Command | Result |
| --- | --- |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | no warnings |
| `cargo fmt --all --check` | clean |
| `cargo test --workspace --locked` (with `DATABASE_URL` set) | every suite passes, none failed |
| `cargo test -p rampsmith-db --test tenancy` | 32 pass; the six new tables are in `TENANT_TABLES` (29) and `R1_TABLES` (17) |
| `cargo test -p rampsmith-db --test github` | 6 pass |
| `cargo test -p rampsmith-api --test github_channel` | 8 pass |
| `cargo test -p rampsmith-api --test github_webhook` | 7 pass |
| `cargo test -p rampsmith-ctl --test github` | 8 pass |
| `cargo test -p rampsmith-rsctl --locked` | pass (variable registry matches LAUNCH.md C row 4) |
| `python -m unittest` in `infra/railway/tests` | 105 pass |
| contract drift (`gen-openapi`, `generate-api.ts`) | regenerated, committed |

## Audit items closed here

M1 (body-digest dedupe, state read from the API), M2 (no finding text in commits), L2, L3, L7
(state bound to the tenant, single use, user token dropped), L8 (unique tenant, repo id, number),
L9 (key parsed at boot, credentials leave config).

## Live checks still open

LAUNCH.md section E carries the rows: the install flow on the real App (including whether GitHub
echoes `state`), and the webhook on the real App. They need C rows 3 and 4. They are not passed.
