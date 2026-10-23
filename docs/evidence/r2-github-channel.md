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

# R2 GitHub channel, part 2: the patch pipeline (PR2)

Scope: ADR-295 to ADR-299. Local toolchain Rust 1.97, Node 26.12.0, Postgres 18 (private
instance), Chromium at `/tmp/chromium`.

## Commands run

| Command | Result |
| --- | --- |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | no warnings |
| `cargo test -p rampsmith-ctl --test github` | 16 pass |
| `cargo test -p rampsmith-api --test github_channel` | 11 pass |
| `cargo test -p rampsmith-db --test github` | 8 pass |
| `vitest run` in `packages/liquid-patch` | 270 pass, 97.22% lines |
| `vitest run` in `packages/engine` (unit) | 341 pass, 3 skipped (the skips are the live tests, LAUNCH.md section E) |
| `tsc --noEmit`, `eslint src test`, `prettier --check` in `packages/engine` | clean |
| `vitest run --config vitest.e2e.config.ts test/scan.e2e.ts` | the new form-with-field-named-`id` test passes; six existing tests fail here only because `target/debug/egress` is not built in this environment (CI builds it) |

## Corpus measure (ADR-249 baseline 35/35)

`pnpm --filter @rampsmith/corpus-tools exec node src/cli.ts run` (commit c6a5b5b):

| Measure | Result | Gate |
| --- | --- | --- |
| Source mapping | 48 of 48 correct, 0 wrong above confidence 0.9 | pass |
| Targeted findings fixed | 35 of 35 | at least 90%: pass |
| Render regressions | 0 | zero: pass |

## Production-shaped run (reported honestly)

The corpus runner above feeds the recipes the findings it knows, with the judgements a person would
give. `packages/engine/test/code-fix.corpus.e2e.ts` runs the path the product runs: it serves each
failing corpus theme, scans its pages in Chromium with the engine scanner, stores the findings and
occurrences as the scan store does, runs `batchFindings` and `planBatch` with no judgements, applies
the result, re-renders and rescans. It asserts that no fixed finding still fires and that the patched
theme has no new finding.

Result: 10 of 59 findings fixed across the three failing themes; the assertions hold (none still
firing, none new). This is below 90%, and it is the honest figure for a batch with no merchant words:

| Theme | Skipped, by reason |
| --- | --- |
| aurora | 16 need a person's label or reason (`invalid-parameter`), 2 `needs-review` (several sources fit), 1 `unmapped` (an `img` whose attributes were scrubbed) |
| birch | 10 need a person's words, 1 `needs-review`, 7 `already-fixed` (an earlier fix in the batch covered them) |
| cedar | 9 have no recipe (ARIA structure, `target-size`, `listitem`, `frame-title`, `link-in-text-block`), 2 need a person's words, 1 `already-fixed` |

Two real defects were found by this run and fixed: ctl read too narrow a set of files (the mapper
needs templates, config, locales and CSS: ADR-298), and the scanner lost the section of every element
inside a form with a field named `id` (ADR-297, with a regression test). Open: attributes holding
digit runs that Shopify generates are scrubbed as phone numbers and cannot be matched, so such a
finding is skipped as unmapped.

## Live checks still open

Section E of LAUNCH.md has the rows: a live pull request on the test repository, the real theme
read, and pull request state sync. They need rows 3 and 4 of section C. They are not passed.

# R2 GitHub channel, part 3: the App Home screen and the GitHub hops (PR3)

Scope: ADR-291 (App Home section). Local: Node 26.12.0, Chromium at `/tmp/chromium`, the built web
server against `tests/app-fake-api.ts` and `tests/mock-api.ts`.

| Command | Result |
| --- | --- |
| `svelte-check --fail-on-warnings` in `apps/web` | 0 errors, 0 warnings |
| `vitest run` in `apps/web` | 24 files, all pass (new: `github-connect.test.ts`, proxy and header cases) |
| `playwright test` over the `app-home` and `site` projects (the dashboard project needs the api binary and is run by CI) | 184 pass, 1 skipped (the live Turnstile check, which names C row 6) |
| `tests/app-axe.spec.ts`, Code fixes in five states (connected, not connected, plan locked, channel off, api error) | 0 violations at WCAG 2.2 A and AA |
| `tests/app-codefix.spec.ts` | 6 pass: keyboard-only connect (focus lands on the continue link), repository save, request and follow to a pull request, disconnect, plan gate, flag off |
| `tests/site-github.spec.ts` | 9 pass: cookie flags and redirect, malformed state, callback hands the cookie state to the api and clears the cookie, no cookie never reaches the api, the api's 403/409/400/502 shown as words, bad installation id |
| `cargo test -p rampsmith-rsctl` | pass, including the registry test with `GITHUB_APP_SLUG` in C row 4 and the new slug mismatch case |
| `knip`, `eslint`, `prettier --check`, claims lint | clean |

The Svelte autofixer was run on the screen's script and markup patterns: no issues, only the
polling-in-`$effect` suggestions that the existing Fixes screen shares.

## Not proved here

The real Polaris components, the real GitHub redirect and whether GitHub echoes `state`: LAUNCH.md
section E has the row. Not passed.
