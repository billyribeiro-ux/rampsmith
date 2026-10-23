# R1 integration: evidence

Branch `r1-integration`, from `main` after lanes A, B, C, the marketing site and the backup
hardening. Environment: Postgres 18 at 127.0.0.1:55500, Node 26.12.0, pnpm 12.14.0, Rust stable
(1.99), Chromium at `/opt/google/chrome/chrome`. CI run links are in `docs/STATUS.md`.

## The eight gaps

| # | Gap | Evidence |
| --- | --- | --- |
| 1 | `scan.page@1` removed from contracts and generated TypeScript | `crates/contracts` has no `ScanPage`; regenerating (`cargo run -p rampsmith-contracts --bin gen-schemas -- packages/contracts-ts/schemas`, then `node packages/contracts-ts/scripts/generate.ts …`) leaves `packages/contracts-ts` unchanged; `scan-page.schema.json` and `generated/scan-page.ts` are deleted; `cargo test -p rampsmith-contracts` and `pnpm --filter @rampsmith/contracts-ts test` pass |
| 2 | Storefront password reaches the engine | ADR-266. ctl opens `sites.storefront_password_ct` under the master keys and re-seals it under `RAMPSMITH_SCAN_SECRET_KEYS` for one scan (context `scans/storefront_password/<scan id>`); the engine supplies it through `EngineDeps.storefrontPassword`; the copy is cleared on finalize, verify or failure. Tests: `crates/ctl/src/jobs/scan_secret.rs`, `crates/crypto/tests/vector.rs` with `vectors/scan-secret.txt` (the same vector opened by `packages/engine/test/scan-secret.test.ts`), `crates/db/tests/`, `crates/ctl/src/config.rs::the_scan_secret_ring_is_optional_but_never_malformed`. No log line carries the password |
| 3 | The engine sets `scans.ruleset_version` | `packages/a11y-rules/src/version.ts`, `packages/engine/src/ruleset.ts` (`axe-core <v>; a11y-rules <hash>`); asserted in `packages/engine/test/pipeline.test.ts` for plan, finalize and verify; the api's `PLACEHOLDER_RULESET` is only a fallback for scans that predate it |
| 4 | Overview `shop.name` | Migration `20261105000003_shop_name.sql`; `shopify.read_store` stores it; `get_overview` returns it; `crates/ctl/tests/read_store.rs`, `crates/api/tests/app.rs` |
| 5 | Free scanner connected to a real anonymous path | ADR-267. Migration `20261105000005_free_scans.sql`; `POST /v1/free-scans` and `GET /v1/free-scans/{id}` in `crates/api/src/free_scan.rs` (Turnstile verified before enqueue, fail closed; 3 per address and 1 per domain per day, 40 in flight; a complete scan of the last 24 hours is the cache); engine job `free_scan.run@1` (`packages/engine/src/free-scan.ts`: robots.txt through egress, home page and up to two linked pages); retention sweep every 10 minutes from ctl (`free_scans_sweep`, `scan_inputs`); web `FREE_SCANNER_BACKEND=api` |
| 6 | LAUNCH.md section E rows | 15 rows added or updated; C rows 6 and 12 updated. Live tests, each skipping with a notice that names its row: `crates/shopify-admin/tests/live.rs`, `crates/api/tests/live.rs`, `packages/engine/test/ai/live.test.ts`, `packages/engine/test/pipeline.e2e.ts` ("a live store"), `packages/engine/test/storefront-password.live.test.ts`, `packages/engine/test/free-scan.live.test.ts`, `apps/web/tests/site-turnstile-live.spec.ts` |
| 7 | Every tenant table is in `crates/db/tests/tenancy.rs` | The suite lists 23 tenant tables (`shop_billing` was missing and is added; `ai_draft_holds` and `webhook_digests` arrived from the lane audit fixes and are added) and a catalog self-check test fails when a table with a `tenant_id` column is not listed |
| 8 | Lane A's concurrent-approval test needs the `lock_site` row lock | See below |

## Gap 8: the lock is what makes the test pass

Test: `crates/api/tests/app.rs::two_approvals_at_once_cannot_pass_the_last_image_of_the_allowance` (two simultaneous approvals of the same
site; one must win with 200 and the other must be refused with 403). Command, five runs each:

    cargo test -p rampsmith-api --test app two_approvals_at_once_cannot_pass_the_last_image_of_the_allowance -- --exact

Without the `lock_site` call (removed in the working tree, nothing else changed): failed 5 of 5,
`left: [200, 200]`, `right: [200, 403]`, which is both approvals succeeding. With `lock_site`
restored: passed 5 of 5. The full `--test app` run with the lock: 25 passed. The lock stays.

## Test runs

| Suite | Command | Result |
| --- | --- | --- |
| db free scans | `cargo test -p rampsmith-db --test free_scans` | 8 passed |
| api free scans | `cargo test -p rampsmith-api --test free_scan` | 11 passed |
| ctl | `cargo test -p rampsmith-ctl` | 20 integration tests and the config unit tests passed |
| engine | `pnpm --filter @rampsmith/engine exec vitest run` | 216 passed, 3 skipped (the live checks, each with a notice) |
| engine free-scan e2e | `RAMPSMITH_EGRESS_BIN=… PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome DATABASE_URL=… pnpm --filter @rampsmith/engine exec vitest run --config vitest.e2e.config.ts test/free-scan.e2e.ts` | passed |
| web unit | `pnpm --filter @rampsmith/web exec vitest run` | 211 passed |
| web e2e, site project | `pnpm --filter @rampsmith/web exec playwright test --project=site` | 81 passed, 1 skipped (the live Turnstile spec, naming row 6) |
| Railway IaC | `python3 -B -m unittest discover infra/railway/tests` | 88 passed |

## A defect found on the way

The first web e2e run returned HTTP 500 on every scanner POST. SvelteKit refuses a page that has
both a default action and a named one, and the "Check again" form had been added as `?/status`
next to the default action. The status request is now a field (`scan`) of the default action.
`apps/web/tests/site-scanner-api.spec.ts` covers it against the real api.

## Open items

- ctl's re-wrap job (`rewrap.rs`) covers the Shopify tokens only, not `sites.storefront_password_ct`;
  retiring a master key needs the merchant to enter the password again (ADR-266).
- `rsctl doctor` does not check `RAMPSMITH_SCAN_SECRET_KEYS` or `FREE_SCAN_SERVICE_TOKEN` yet.
- Free scans block third-party-host styles and scripts (egress allows only the site and the
  Shopify CDN), which can change contrast results on sites that load styles elsewhere.
- `scan_inputs_sweep` is wired to the leader for the first time here.

## Migration versions

`main` held two migrations with the version `20261105000001` (`r1_c_audit_limits` and
`webhook_digests`, merged by parallel pull requests), which sqlx refuses. The integration renumbers
`webhook_digests` to `20261105000002` and puts its own migrations at `…03`, `…04` and `…05`.
