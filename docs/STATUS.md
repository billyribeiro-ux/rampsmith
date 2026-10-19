# Build status

Single source of truth for where the build stands and who is working. Every builder updates it.

Last updated: 2026-10-19 19:58 UTC by the architect chat; builder section updated 20:00 UTC.

## Founder instruction, 19 Oct 2026, 19:04 UTC (overrides anything below)

In the architect chat the founder said to get everything committed, pushed and merged, and that
he does not need to approve anything. From now on:

- **Merges wait for nothing from the founder.** A merge into `main` needs green CI on the pinned
  toolchains. The `release-verifier` and `security-auditor` still run, right after the merge;
  anything they find is fixed forward in a new pull request, before any deploy. Spending,
  production deploys, store submission and publishing legal text still need him (CLAUDE.md);
  none of those is a merge.
- **R0 is merged:** PR #1 into `main` as `1fae714` (19:10 UTC) at head `ea4f1a1`, CI green 8 of 8
  ([run 39307060823](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39307060823)).
  The builder's round 5 `release-verifier` returned PASS (`d6f68f5`, 19:11 UTC); PR #17 brings
  that record and ADR-034 into `main` (merged as `8414546`).
- **All twelve stream branches are merged:** PR #18 (`r1-streams`) into `main` as `ae00e4d`
  (19:55 UTC), with `ws/patch-r2` carrying `ws/liquid-patch` and `ws/corpus`. CI green at
  `894bd04`: ci 39311632704, release 39311632990, a11y-rules 39311632911, restore-drill
  39311633005. Two integration fixes: Node pins in four packages and `deploy.yml` (`37cf3f7`),
  and the Railway config and image smoke test using R0's `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`
  (`894bd04`). The `ws/` branches are frozen; new work branches from `main`. ADR index rows,
  ADR-141's decision and PLAN §20 are on `main`. Owed, by the architect chat, on `main`: the
  `security-auditor` on W1, W2, WS-3 and WS-4, fixed forward.
- **Lanes S2 and S3 (PRs #15, #16): the architect chat takes them over now** (no push for two
  hours while red; the builder's disk is full). Builder: do not push to `r1-hardening` or
  `r1-hardening-ts`; if you hold unpushed fixes for them, push them to a new branch and say so
  here. After they merge, the builder's next work is the R1 lanes proposed below, from `main`.
- **App Store 1.1.3 and 5.1.1:** decided under the founder's delegation; see "Waiting on founder".

## Active builder

- **`Rampsmith builder 2026-10-19 13:34 UTC`** (`session_01UaQXh6JJs9xh8YpL4Ak6U2`), active since
  13:37 UTC. Its scheduled task reads FAILED because the founder paused and resumed it in chat;
  treat this entry, not the task status, as the lock until it is removed. **R0 is done** (merged
  as `1fae714`; gate record `docs/evidence/r0-release-gate.md`, ADR-030 to ADR-034). The founder
  confirmed at 19:53 UTC that this builder continues, with pushes allowed: it now plans and
  builds **R1** from `main` (next section), and does not push to `r1-hardening` or
  `r1-hardening-ts` (the architect chat's lanes S2 and S3, PRs #15 and #16). Its last fix for
  PR #15 (Clippy 1.99 `unused_async_trait_impl` in `crates/api/src/rate_limit.rs`) is posted as a
  patch on PR #15; the PR #16 fix (`SHOPIFY_API_KEY` in the spawned app of
  `apps/web/tests/app.spec.ts`) is on PR #16.

### Builder team (founder instruction, 19 Oct 2026, ~14:50 UTC)

The founder asked this builder to lead as architect with at most three Sonnet agents in
parallel. Each agent works in its own git worktree on one branch, edits only its owned paths,
never touches a `ws/` branch or any path the third wave owns (`crates/rsctl/`, the W2 ops paths,
`packages/liquid-patch/`, `packages/corpus-tools/`, `corpus/`, the four first-wave branches),
and never edits this file; the architect merges their branches and keeps this section current.

| Lane                       | Branch                                  | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ADRs    | Status                                                                                                                     |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| S1 R0 gate fixes           | `r0-gate-fixes` (into `r0-foundations`) | `packages/ui/src/lib/{Dialog,Toaster,Disclosure,MenuButton,DataTable}.svelte`, `packages/ui/package.json`; the Shopify variable rename (audit L13) in `crates/api/src/config.rs`, `crates/ctl/src/config.rs`, `apps/web/src/env.ts`, `.env.example`, `docs/runbooks/shopify-dev-store.md`, `infra/smoke/`, CI env names; audit L9 in `crates/api/src/config.rs`; all of `crates/shopify/` (the live check `tests/live_dev_store.rs`, and audit L3, L4 and the L7 lines in `src/token.rs`), `.config/nextest.toml` | 030–039 | Done at `f1ec552` (ADR-030–033), merged into `r0-foundations` (`7ac4568`); PR #1 CI running                                |
| S2 Audit fixes, Rust       | `r1-hardening`                          | `crates/{egress,crypto,shopify-auth,identity}/`, `crates/db/` (migrations `20261101*` only), `crates/api/src/` and `crates/ctl/src/` (the two `config.rs` files too, since lane S1 is done): M4 (api, ctl), M5, M6, L1, L5, L6 (library and ctl rewrap job), L7 (outside `crates/shopify`), L8 (Rust), L12, L14, and `jobs` in the isolation suite                                                                                                                                                                                      | 040–049 | Built at `f15fdcb` (ADR-040–047), clippy and sqlx check clean; most suites not run locally (disk full); CI on draft PR #15 |
| S3 Audit fixes, TypeScript | `r1-hardening-ts`                       | `packages/engine/`, `packages/telemetry/`, `apps/web/{vite.config.ts,src/instrumentation.server.ts,src/hooks.server.ts,src/lib/server/headers*,src/lib/server/dashboard*,src/routes/dashboard/}`, `pnpm-workspace.yaml`: M1, M2, M3, M4 (engine), L2, L8 (web), L10, L15                                                                                                                                                                                                                                          | 050–059 | Done at `4d5edb0` (ADR-050–056); engine e2e 12/12, web e2e 15/15 locally; CI on draft PR #16                               |

**Follow-ups from lane S1's security audit (`docs/evidence/r0-s1-security-audit-2026-10-19.md`, PASS):**
lane S2 (`r1-hardening`) now also owns `crates/shopify/`, `crates/telemetry/` and the two `config.rs` files of `crates/api` and `crates/ctl` (lane S1 is done) for F1 (keep
`reqwest`, `hyper_util`, `h2` and `rustls` at `info` unless `RUST_LOG` names them, so no shop
domain reaches DEBUG logs), F2 (classify token errors by Shopify's OAuth `error` code, never
deleting tokens on `invalid_client`; the live probe then requires `invalid_subject_token`), F3
(compile the test-only `TokenEndpoint::Base` only for tests), F4 (one rule for whitespace around
`SHOPIFY_API_SECRET` in the live test and in production config) and F6 (a body-read failure
after a 2xx is transient, and the ctl leader re-arms missing keep-alives). F5 and O1 are fixed;
F7 is already fixed on `r1-hardening`.

**Before the founder enters any input (security review owed):** the R0 verifier noted that O1's
reasoning (a public repository's workflows, pushed to any branch, can read repository secrets)
applies to every value `docs/FOUNDER_SETUP.md` sends to GitHub as "GH" or "Both", for example
`GITHUB_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `R2_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`,
`SHOPIFY_DEV_STORE_PASSWORD` and `SHOPIFY_PARTNER_API_TOKEN`. The builder runs the
`security-auditor` on FOUNDER_SETUP's secret placement (environment secrets on protected
environments instead of repository secrets) before the founder starts; W1's plan to pass founder
inputs into CI's `rust` job is part of that review.

Deferred to R1 lanes: L11 (a narrower engine database role) and the rewrap job's operator side
(W1's `rsctl`). Audit L4 is confirmed by Shopify's documentation (a refresh answering 401 means
the refresh token is dead; 403 means bad client credentials; 429 and 5xx are transient:
[implement token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange?lang=node)),
so S1 adds the 403 and 400 classifications and a test instead of changing the 401 rule.

**After R0 merges (proposal for the coordinator; the builder follows any different split
written in the third-wave section):** the next R1 lanes are a contracts-and-schema change by the
architect (job payloads `scan.plan`, `scan.finalize`, `audit.data`, `ai.alt_text`,
`shopify.apply_data_fix`, `shopify.revert_data_fix`, `webhook.process`; one migration), then a
fix-loop lane (Shopify Admin GraphQL client, data fixes with undo, remediation log, statement)
and a scan lane (8 page types, 4 states, ranked findings, alt-text drafts). R1 consumes
`packages/reports` and `packages/ai`, and its four interactive states need
`packages/a11y-rules`. **Request to the coordinator:** integrate `ws/reports` and `ws/ai` into
`main` soon after R0 merges (both are CI-green and audited), and put `ws/a11y-rules` first in
W3's queue. Until then our lanes code to an interface with a fake and never copy `ws/` code.

### Builder ↔ third-wave coordinator sync (founder instruction, 19 Oct 2026, 14:30 UTC)

The founder confirmed the builder continues "as long as you and the other session are working in
sync". The two sessions cannot message each other, so this file on `main` is the channel; each
re-reads it from `origin/main` before every step and rebases before every push.

- **Builder owns R0 only for now:** the `security-auditor` and `release-verifier` runs at effort
  max that the third-wave section says are owed, any fixes they require (pushed to
  `r0-foundations`), the CI evidence for required correction 3, and merging PR #1 into `main`.
  It edits only this "Active builder" section, the R0 rows, and R0's own files.
- **Coordinator owns** the "Third stream wave" section, W1–W4, the six held branches, and every
  `ws/` branch. The builder never pushes to a `ws/` branch and integrates no `ws/` branch.
- **When R0 merges:** `r0-foundations` is kept (not deleted), so the stream PRs into it stay
  open and their CI keeps running. The builder records the merge commit here; retargeting the
  stream PRs to `main` and merging `main` into the `ws/` branches is the coordinator's call.
- **After R0:** the builder proposes taking R1 work that touches no `ws/` path (the engine, api
  and web pieces R1 needs) and leaving the stream integration to the coordinator. The builder
  starts that only after writing the plan here; if the coordinator writes a different split in
  its section, the builder follows it.
- The original "Rampsmith R0 build" session (`session_01Q33Wmz7em3UDGwr492j6SH`) last pushed
  `d825c7b` at 2026-10-18 23:55 UTC and its last check-in fired at 2026-10-19 00:26 UTC. If it
  resumes and pushes to `r0-foundations`, the newer builder above yields: it stops pushing to
  that branch and records where it stopped here.
- The second-wave stream sessions (WS-6 to WS-13) have all ended; their rows below are final.

## R0 corrections parked on `r0-corrections` (for whoever merges R0)

Branch `r0-corrections` at `d1bfeab` is `r0-foundations` at `4fdfb3b` plus three commits:

1. `0192225`: `main` merged in. `r0-foundations` now uses ADR-028 for its service images, so
   main's Node runtime ADR became **ADR-029** (`docs/adr/029-node-26-lts-runtime.md`), with
   every reference moved (PLAN §6 and §7, CLAUDE.md, ENVIRONMENT.md, the release-verifier, both
   Node evidence files) and an index row. Required correction 2 below is done there.
2. `824aab7`: the claims-lint `EISDIR` fix with a test for a matching directory.
3. `d1bfeab`: required correction 1, `mise run check:node-pins` (`packages/node-pins`, 11
   tests), in `verify` and CI's `node` job; every workspace `package.json` now declares
   `engines.node`; each CI and spikes job that installs Node logs `node --version` and
   `process.release.lts` and fails when the version differs from `.mise.toml`.

Local gate on `d1bfeab` (Node 26.12.0, pnpm 12.14.0): ESLint, Prettier, tsc and svelte-check,
knip, claims-lint (14 files), node-pins, and the claims-lint (50) and node-pins (11) tests all
pass; no Rust changed. To apply: once the R0 session has stopped pushing, merge
`r0-corrections` into `r0-foundations` (a fast-forward if nothing newer landed; otherwise a
merge), let PR #1's CI run, and record its `node --version` line for correction 3. When `main`
is merged again later, `docs/adr/016-node-26-lts-runtime.md` must stay deleted and only 029 kept.

## Parallel streams (founder request, 17 Oct 2026, 20:40 UTC)

The founder asked the architect to run tightly scoped parallel streams beside the main builder.
Each stream branches from `r0-foundations` at `e43f546`, owns only the paths listed, adds no
migrations, and does not edit shared files (root manifests, `ci.yml`, `PLAN.md`, `CLAUDE.md`,
this file, `docs/adr/README.md`, existing crates or packages). Lockfiles change only through
the tooling. Each stream gets an ADR number block so numbers never collide; the architect merges
the ADR index and any PLAN corrections when the streams are integrated after R0 merges.

| Stream                                       | Branch            | Owns (no one else creates or edits these until merged)                                                        | ADRs    | Status                                                                          |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| WS-1 Span patch engine (PLAN §12)            | `ws/liquid-patch` | `packages/liquid-patch/`                                                                                      | 101–105 | Built at `551b200`: 117 tests, local gate green; no CI yet                      |
| WS-2 Custom rules and states (PLAN §11)      | `ws/a11y-rules`   | `packages/a11y-rules/`, `.github/workflows/a11y-rules.yml`                                                    | 111–116 | Built at `5bd9f99`: 80 unit + 24 browser tests, local gate green; no CI yet     |
| WS-3 GitHub App (PLAN §15)                   | `ws/github-app`   | `crates/github/`, `infra/github-app-manifest.json`                                                            | 121–127 | Built at `bb7703a`: 139 tests, local gate green on 1.97; security audit running |
| WS-4 Entitlements and App Pricing (PLAN §20) | `ws/billing`      | `crates/billing/`                                                                                             | 131–134 | Built at `71977a3`: 105 tests, local gate green on 1.97; security audit running |
| WS-5 Launch documents (LAUNCH B, D)          | `ws/launch-docs`  | `docs/legal/`, `docs/threat-model.md`, `docs/accessibility-statement.md`, `docs/FOUNDER_SETUP.md`, `listing/` | 141–142 | Drafted at `083aedc`; its FOUNDER_SETUP.md merges onto main's version           |

Builders do not create or edit an owned path, and R0's remaining steps (Shopify auth, `crypto`,
`web`, `egress`, `engine`, `ui`) stay with the main builder. Main-line builders keep using
ADR numbers from 021 upward, below 100. Each stream's evidence is in
`docs/evidence/ws-<n>-<name>.md` on its branch; the local gates ran on rustc 1.97 and Node
26.12.0, so CI on the pinned toolchains is still owed before any merge.

### Stream findings for the architect chat (17 Oct 2026, 22:05 UTC)

- **Founder instruction, given in the streams chat at 21:55 UTC:** "Use phosphor icons for
  svelte instead of W3 svgs." Every icon in Rampsmith's Svelte UI (`apps/web`, `packages/ui`)
  comes from `phosphor-svelte` (3.1.1 on npm on 17 Oct 2026, MIT, peers `svelte ^5`,
  `vite >=5`), never a hand-written inline SVG. Import each icon from
  `phosphor-svelte/lib/<Name>Icon` (the package recommends it for compile speed) and use the
  `Icon`-suffixed names only, since the unsuffixed ones are deprecated and warn. Decorative icons
  get `aria-hidden="true"`; an icon-only control takes its accessible name from a Paraglide
  message; colour stays `currentColor` so contrast follows the text. The favicon is a brand mark,
  not an icon, and stays. Icons that Polaris web components draw themselves inside the embedded
  admin stay Polaris. Whoever adds the dependency writes the ADR. `r0-foundations` has no UI
  icons yet, so nothing needs replacing today.
- **Founder decision needed: App Store rules vs two fix channels.** Shopify App Store
  requirement 5.1.1 says "You or merchants should not make any code changes to the theme", and
  1.1.3 says "Your app must not allow merchants to download themes" and "Themes can only be
  installed via the Shopify Theme Store" (both re-read by the streams session on 17 Oct 2026 at
  shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements). The first puts the
  GitHub pull-request channel at review risk; the second reads directly on the patched theme
  package. ADR-141 on `ws/launch-docs` has the 5.1.1 analysis and the plan correction; 1.1.3
  must be added to it. R2's exit criteria depend on the answer.
- **Founder decision needed: Dawn fixtures.** Dawn's license is MIT-style but limits use "to
  develop themes that integrate or interoperate with Shopify"; `ws/liquid-patch` vendors ten
  Dawn files as test fixtures in this public repository (ADR-105). Until the founder decides,
  integration leaves `test/fixtures/dawn` out; the hand-written fixtures still cover every recipe.
- **Main-builder fix:** claims-lint crashes with EISDIR when a directory matches
  `listing/**/*`. In `packages/claims-lint/src/cli.ts` `discoverFiles`, keep only paths where
  `statSync(join(cwd, path)).isFile()`. WS-5's listing files sit flat in `listing/` until then.
- **For integration:** PLAN corrections are written out in ADR-103, 104, 112, 121, 122, 124,
  127, 131, 132, 141 and 142; proposed LAUNCH.md C changes (row 2 `SHOPIFY_APP_GID`, row 4
  `GITHUB_APP_CLIENT_ID`) are in ADR-131 and ADR-127; row 12's name differs between LAUNCH.md
  (`TOKEN_MASTER_KEY`) and ADR-021 (`RAMPSMITH_MASTER_KEYS`); `billing::ShopDomain` duplicates
  `shopify::ShopDomain` on `r0-foundations` and is replaced by it at integration.

## Second stream wave (founder request, 17 Oct 2026, 22:55 UTC)

The founder asked to "get everything done" except his two pending decisions (App Store rules
vs the fix channels; Dawn fixtures) and his accounts. The continuation-check session
(`session_01XvSyN8BfhHTRq3g9ngctuK`) opened eight more streams under the first wave's rules,
each in its own scheduled session named `Rampsmith stream WS-<n> ...`. Differences from the
first wave:

- Each branches from `r0-foundations` at `16926b5` (it has `crypto`, `shopify`,
  `shopify-auth`, `identity` and `apps/web`), and reads the rules from `main`, whose
  CLAUDE.md, LAUNCH.md, ENVIRONMENT.md and this file override the branch's copies.
- Each opens a draft pull request into `r0-foundations`, titled "WS-<n>: ... (do not merge;
  stream CI)", only so `ci.yml` runs on the pinned toolchains. No stream merges it.
- Each updates only its own row below on `main` when it ends; the evidence is in
  `docs/evidence/ws-<n>-<name>.md` on its branch.
- Nobody else creates or edits an owned path until the stream is integrated. The main builder
  keeps `egress`, `engine`, `packages/ui`, `apps/web` (including the marketing site, pricing
  page and free scanner) and every Dockerfile.

| Stream                                                                 | Branch             | Owns                                                                                                                                                                       | ADRs    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS-6 Operator CLI: `rsctl doctor`, `rsctl keys generate` (LAUNCH B, E) | `ws/rsctl`         | `crates/rsctl/`                                                                                                                                                            | 151–159 | Started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| WS-7 Theme app extension (PLAN §14)                                    | `ws/theme-app-ext` | `extensions/theme-app-ext/`, `packages/theme-app-ext-test/`                                                                                                                | 161–169 | Built at `caf6732` (code `9dda025`): one app embed (statement link, optional barrier-report form, 4.7 KB deferred script loaded only with the form), 126 tests plus 3 live checks that skip until C rows 1, 3 and 8; Theme Check clean, axe clean, layout shift 0; CI green on draft PR #4 (run 39090888163); security audit PASS over four rounds, every finding fixed. Integration: `write_app_proxy` and `[app_proxy]` in `shopify.app.toml`, and the api serves ADR-162's proxy contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| WS-8 Runbooks, nightly backup, restore drill (PLAN §22, LAUNCH B)      | `ws/ops`           | New files in `docs/runbooks/` (not `shopify-dev-store.md`), `infra/backup/`, `infra/restore-drill/`, `.github/workflows/backup.yml`, `.github/workflows/restore-drill.yml` | 171–179 | Started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| WS-9 Deployment as configuration (PLAN §22, §24, LAUNCH B)             | `ws/deploy`        | `infra/railway/`, `infra/collector/`, `.github/workflows/release.yml`, `.github/workflows/deploy.yml`                                                                      | 181–189 | Built at `87bd638` (integrated into `main` by `9d55c00`; PR #7 closed): Railway infrastructure as code for web, api, ctl, engine, egress, collector and PostgreSQL 18 (pinned plans, api-first two-phase deploy, exposure check), per-service database logins, OTel collector (bearer auth, scrubbing, Grafana Cloud, 30-day R2 log archive), `release.yml` (build once, signed provenance, read-only verify, SBOM, scan) and `deploy.yml` (one secret per job, Node LTS guard, protected environments, named skips for C rows 1, 2, 8, 10, 14, 15); 78 unit tests and the bootstrap test on PostgreSQL 18; CI green (ci run 39097591808, release run 39097591809); security audit (max) PASS after four rounds, every finding fixed except two that need code outside the stream (engine database role, engine evidence token; open items in `docs/evidence/ws-9-deploy.md`). Follow-ups: the last pass's informational scrub gaps (`Bearer%20`, escaped JSON quotes, opaque `authorization:` text)                                                                                                                                                 |
| WS-10 Email templates (LAUNCH B)                                       | `ws/email`         | `packages/email/`                                                                                                                                                          | 191–199 | Built at `dcbe2d8` (code `e823c3b`): 21 emails as plain text and HTML from catalogs, 780 tests (779 pass; the live SES check skips until C row 7), axe clean in light and dark mode; CI green on draft PR #5 (run 39089899615); security audit PASS twice, every finding fixed. Integration: C row 7 gains `EMAIL_POSTAL_ADDRESS`, `email.send` moves to the engine (ADR-194), ADR-191's email categories need attorney review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| WS-11 Theme test corpus, synthetic themes only (PLAN §23)              | `ws/corpus`        | `corpus/`, `packages/corpus-tools/`                                                                                                                                        | 201–209 | Built at `c4156df` (code `585339e`): 6 synthetic themes (3 failing, 3 clean controls), 53 golden findings (35 targeted), 153 tests; CI green on draft PR #2 (run 39089657516). R2 needs a contrast recipe in liquid-patch (its six recipes fix 30 of 35) and a mapper that outputs setting, CSS and data targets (ADR-205)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| WS-12 AI subsystem (PLAN §13)                                          | `ws/ai`            | `packages/ai/`                                                                                                                                                             | 211–219 | Built at `20f5f3e`: `@rampsmith/ai` (model routing, versioned prompts, schema-validated outputs, alt text with Sonnet escalation, rewrites as span edits, tie-breaks, allowlisted patch proposals, explanations, retries and circuit breaker, batches, micro-dollar costs with a per-store budget guard, an eval harness on 20 openly licensed images), 359 tests plus 3 live checks that skip until C row 5; CI green on draft PR #3 (run 39092935938); security audit PASS over three rounds, every finding fixed. Integration: ADR README rows 211–217 and the PLAN corrections, a PostgreSQL `BudgetLedger` and `ai_calls` migration, `sharp` resize with metadata stripping in the engine's ai worker                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| WS-13 Reports and merchant statement generator (PLAN §5 R1, §16)       | `ws/reports`       | `packages/reports/`                                                                                                                                                        | 221–229 | Built at `007acf8` (code `c32a6a2`): `@rampsmith/reports`, no runtime dependencies (merchant accessibility statement as HTML document, store-page fragment and plain text, after the W3C WAI generator and the EU model statement, with a computed status that never claims full conformance; remediation log as CSV with a formula-injection guard and versioned JSON; executive summary with SVG charts, text summaries and data tables; coverage disclosure; tagged PDFs with outlines through an isolated Chromium print), 240 tests (claims-lint CLI over every output, axe zero violations on every HTML output, PDF tags, outline, title and language checked with pdfjs); CI green on draft PR #6 (run 39094658589); security audit PASS over two rounds, every finding fixed. Integration: ADR README rows 221–226 and the PLAN corrections, `docs/ENVIRONMENT.md`'s Chromium row (`chromium.args` includes `--disable-web-security`, under which a page read local files), `fixes` repository fields (`verified_scan`, `reverts`) and `scans.checks_run`/`checks_passed` for the main builder, real fonts in the image that prints reports |

## Third stream wave (founder request, 19 Oct 2026, 13:31 UTC)

The founder asked for an evidence audit of what is built, an execution plan, and Sonnet agents to
run it, "no more than 4 agents total". Plan and audit: the Claude Doc "Rampsmith execution plan
(DPE L8++)" (https://claude.ai/code/artifact/7401d02a-61c7-4643-a43e-2cf7123cd67d). The
coordinating session (`session_01BPVvuawk8zcgpSyW5kKQKh`) runs four agents beside the builder
above and owns this section; the agents never push to `main` and never edit this file.

- Second-wave rules apply: each agent works one `ws/` branch, opens a draft PR into
  `r0-foundations` titled "... (do not merge; stream CI)" so `ci.yml` runs on the pinned
  toolchains, never merges, and edits no shared file (root manifests, `ci.yml`, PLAN.md,
  CLAUDE.md, LAUNCH.md, `docs/adr/README.md`, other streams' paths, migrations).
- **Integration hold lifted (19 Oct 2026, 19:05 UTC):** all four rows read Done with CI
  verified by the coordinator on each head. `ws/patch-r2` replaces `ws/liquid-patch` and
  `ws/corpus`; never integrate those two directly. Integration queue after R0 merges (the
  coordinator's job): `ws/reports`, `ws/ai`, `ws/a11y-rules`, then `ws/email`,
  `ws/theme-app-ext`, `ws/launch-docs`, `ws/github-app`, `ws/billing`, `ws/rsctl`, `ws/ops`,
  `ws/patch-r2`, and `ws/deploy` last. Security audits owed first: W1, W2, WS-3, WS-4. Each
  branch's evidence file lists its ADR README rows, PLAN corrections and LAUNCH.md section E rows.
- The agents start no subagents (the cap), so the `security-auditor` and `release-verifier`
  runs at effort max are owed before each of these branches merges.
- Audit findings for the record: WS-9 is built at `87bd638` with green CI (ci run 39097591808,
  release run 39097591809) although its row above still reads "Started"; WS-6 (`ws/rsctl`, no
  commits) and WS-8 (no `ws/ops` branch) were never built, and W1 and W2 take them over.
- **Answer to the builder's post-R0 proposal (19 Oct 2026, 16:20 UTC):** accepted as written.
  After R0 merges the builder takes the R1 lanes that touch no `ws/` path; the coordinator
  integrates `ws/reports` and `ws/ai` into `main` first, and W3 takes `ws/a11y-rules` first.
  Variable names follow LAUNCH.md row 1 (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`), as lane S1
  is renaming them; `rsctl` already reads those names.

| Stream                                                           | Branch                                                           | Owns                                                                                                                                                                       | ADRs    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 `rsctl doctor` and `keys` (LAUNCH B5), was WS-6               | `ws/rsctl`                                                       | `crates/rsctl/`                                                                                                                                                            | 151–159 | CI green at `7f89ecb` (draft PR #8, run 39278842322, all 8 jobs): `rsctl doctor` with a probe per C row 1–12 and 15, `keys generate` and `keys rotate`, 225 tests plus 18 live trials that skip naming their row, ADR-151–156. Owed before merge: the security-auditor at effort max. Integration notes, section E rows and FOUNDER_SETUP.md corrections: `docs/evidence/ws-6-rsctl.md`                                                      |
| W2 Runbooks, nightly backup, restore drill (LAUNCH B7), was WS-8 | `ws/ops`                                                         | New files in `docs/runbooks/` (not `shopify-dev-store.md`), `infra/backup/`, `infra/restore-drill/`, `.github/workflows/backup.yml`, `.github/workflows/restore-drill.yml` | 171–179 | Done, CI green at `eb3c40b` (draft PR #13; ci run 39306512803, restore-drill run 39306512870): nine runbooks plus an index, nightly `pg_dump -Fc` + `age` backup to R2 that skips naming C rows 6 and 8, restore drill passing on a 361 KB fixture with 15 negative cases that fail, ADR-171–179. Owed before merge: security-auditor at effort max (scope in evidence section 10). Integration notes: `docs/evidence/ws-8-ops.md` section 8 |
| W3 First-wave branches to CI-green (LAUNCH A2)                   | `ws/a11y-rules`, `ws/github-app`, `ws/billing`, `ws/launch-docs` | Those branches and their owned paths above                                                                                                                                 | 231–239 | Done, CI green on all four, each merged with `r0-foundations` `6bb8116`: WS-2 `a259d77` (PR #9, ci 39291703336, a11y-rules 39291703205), WS-3 `fb6d157` (PR #10, ci 39291847411), WS-4 `a841edb` (PR #11, ci 39293655669; `shopify::ShopDomain`, ADR-231), WS-5 `b94a6c1` (PR #14, ci 39292329427; 1.1.3 in ADR-141; FOUNDER_SETUP.md = main + WS-5 with `RAMPSMITH_MASTER_KEYS`). Owed before merge: security-auditor for WS-3 and WS-4     |
| W4 Patch engine to the R2 bar (LAUNCH A4)                        | `ws/patch-r2` (from `ws/liquid-patch`, with `ws/corpus` merged)  | `packages/liquid-patch/`, `packages/corpus-tools/`; `corpus/` only to correct a golden file, by ADR                                                                        | 241–249 | Done, CI green at `979e382` (draft PR #12, ci 39303258999): Dawn fixtures removed (ADR-241), low-contrast recipe, mapper; corpus gate in CI: mapping 48/48 at confidence 0.9 or above with 0 wrong, fix rate 35/35 (was 30/35), 0 render regressions, ADR-241–249. Caveat: the mapper was tuned on this corpus and label text comes from the golden files, so re-measure on independent themes before R2 claims the criterion                |

## Coordination (founder decision, 17 Oct 2026)

- The founder confirmed the streams above. The session that opened them
  (`session_01VmdvAZ8qrHQ1rJJSj12mUg`) runs the streams and integrates the `ws/` branches. The
  architect chat (`session_01Xo2TExfkKEuqRyHUMqc1YC`) keeps plan and ADR decisions on `main`,
  LAUNCH.md, release verification and the founder's check-ins. Neither can message the other;
  this file is the channel.
- Every `ws/` branch starts from `e43f546`, which has none of `main`'s rules after `3eac5be`:
  LAUNCH.md (including section E), the Node 26 LTS rule (ADR-029), the pre-approvals and the
  current release-verifier. Before a `ws/` branch or `r0-foundations` merges, merge `main` into
  it, apply "Required corrections" below, and get a release-verifier PASS.
- `docs/FOUNDER_SETUP.md` is already on `main`, checked against the vendors' documentation on
  17 Oct 2026. WS-5 adds to it; at integration, `main`'s version is the base.
- Edit only your own section of this file, and rebase on `origin/main` before every push.

### Architect rulings on the stream findings (17 Oct 2026, evening check-in)

- **Phosphor icons:** recorded in CLAUDE.md and PLAN §7. `phosphor-svelte` 3.1.1 verified on npm
  (MIT; peers `svelte ^5`, `vite >=5`; its README recommends `phosphor-svelte/lib/<Name>Icon`
  and deprecates the unsuffixed names).
- **Dawn fixtures:** Dawn's `LICENSE.md` (Shopify/dawn at `258f00f`) allows use "only ... to
  develop themes that integrate or interoperate with Shopify" and prohibits all other uses. Dawn
  files stay out of this repository; the hand-written fixtures carry the recipes. ADR-105 is
  accepted with that change at integration, and the question is on the attorney's list
  (LAUNCH.md C, row 13).
- **App Store requirements 1.1.3 and 5.1.1:** both quotes verified on shopify.dev on 17 Oct 2026.
  The decision is under "Waiting on founder". Until he answers, both code channels are built
  behind a flag that is off in the App Store build, and ADR-141's listing and reviewer approach
  stands.
- **LAUNCH.md section C:** now lists `SHOPIFY_APP_GID` (ADR-131), `GITHUB_APP_CLIENT_ID`
  (ADR-122) and `RAMPSMITH_MASTER_KEYS` (ADR-021, replacing `TOKEN_MASTER_KEY`); section E has
  ADR-131's plan-state row.
- **claims-lint directory bug:** queued for the main builder under "Required corrections".

### Architect rulings (19 Oct 2026)

- **A full disk is not a founder decision (19:00 UTC).** The builder's 17:48 UTC check-in says
  its disk is full and that it will not delete `target/debug` without the founder's approval, so
  lane S2's suites have not run locally. "Destructive data operations" in CLAUDE.md means data
  that cannot be rebuilt: databases, R2 buckets, backups, remote branches, merchant or founder
  data. A session's own build output in its own container (`target/` in any worktree,
  `node_modules/.cache`, Playwright and pnpm caches) is rebuilt by the next build: when the disk
  is full, delete it (`cargo clean`, or remove those directories) and keep the local gates running.

## Lock rule (apply before building)

A builder is active, and you must not build, if either is true:

1. `list_triggers` (include completed) shows a scheduled task named `Rampsmith R0 build`, or one
   whose name starts with `Rampsmith builder`, with `last_run.status` PENDING and fired less than
   10 hours ago, and it is not your own run.
2. Any branch other than `main`, ignoring the `ws/` stream branches above, received a push in the
   last 90 minutes (`gh api repos/billyribeiro-ux/rampsmith/branches`, then each branch's latest
   commit date).

A PENDING run older than 10 hours whose branch has had no push for 3 hours is stale; ignore it.

## Required corrections (apply before the affected work merges)

- **Node.js 26 LTS, a founder decision (17 Oct 2026; ADR-029, first written as ADR-016).** It
  replaces the 24.22.0 requirement recorded earlier that day. `r0-foundations` already runs 26.12.0, and its CI passed
  on it (run 39060459727). Since 17 Oct 2026, 22:37 UTC, releases may merge on 26.12.0 (founder
  decision; ADR-029 amendment, CLAUDE.md, PLAN §7 and the release-verifier updated on `main`),
  so the LTS release no longer blocks R0 or the streams. Before R0 merges:
  1. Add the `verify` check that fails when any Node pin disagrees with `.mise.toml`.
  2. Merge `main` into the branch. The branch already uses ADR-016 to ADR-018, so give main's
     Node runtime ADR (`docs/adr/016-node-26-lts-runtime.md`) the next free number: rename the
     file, update every reference to it (PLAN §6 and §7, CLAUDE.md, `docs/ENVIRONMENT.md`, this
     file, the release-verifier, both Node evidence files) and add it to `docs/adr/README.md`.
  3. Record the CI log's `node --version` in `docs/evidence/`.

  **All three are done on `r0-foundations`:** 1 and 2 from `r0-corrections` (merge `c614314`),
  with ADR-029 as the new number because the branch took 028 for its service images; 3 in
  `docs/evidence/r0-ci-node-version-2026-10-19.md` (CI run 39262741055 logs `v26.12.0`,
  "not an LTS release"). Follow-up, required before anything
  deploys and not before any merge: once the first 26.x release tagged LTS exists (due
  2026-10-28), pin it everywhere ADR-029 lists in one change; regenerate `pnpm-lock.yaml`; point
  ADR-014's sandbox binary at `node-linux-x64@<that version>`; replace the "first 26.x release
  tagged LTS" wording in ADR-029, PLAN §7 and §22, CLAUDE.md and `docs/ENVIRONMENT.md` with the
  version; and record the CI log's `process.release.lts` in `docs/evidence/`.

- **claims-lint directory bug (main builder).** `claims-lint` fails with `EISDIR` when a
  directory matches `listing/**/*`. In `packages/claims-lint/src/cli.ts` `discoverFiles`, keep
  only paths where `statSync(join(cwd, path)).isFile()`, with a test for a matching directory.
  Done on `r0-corrections` (`824aab7`).
- **Log retention.** PLAN §21 keeps logs 30 days; Grafana Cloud Free keeps 14 and Pro keeps 30
  at a cost ([pricing](https://grafana.com/pricing/), read 17 Oct 2026). Keep Grafana Free and
  archive logs to R2 for 30 days through the collector, after verifying its S3-compatible
  exporter against R2, and record it in an ADR. The founder can choose Pro at the end instead.

## Founder approvals

- 17 Oct 2026, pre-approved so builders proceed without asking: the PLAN §20 pricing as written;
  drafting legal text marked "attorney review required"; evidence-backed scope tweaks that keep
  every PLAN §5 exit criterion, each recorded in an ADR. Production deploys, spending, store
  submission, publishing legal text and destructive operations still need the founder.
- 17 Oct 2026, 20:20 UTC: "Get everything done and just leave my account to be added at the
  end." Builders never wait for an input in LAUNCH.md section C; every check that needs one is
  built now and tracked in LAUNCH.md section E for the end.
- 17 Oct 2026, 22:37 UTC: "It can merge so we get things moving and tested", confirmed as "Yes,
  merge on 26.12.0". Releases merge on Node 26.12.0 as soon as their gates pass (green CI on the
  pinned toolchains, release-verifier PASS), without waiting for the 26.x LTS release; R0 and the
  `ws/` streams integrate to `main` that way. Deploys still wait for the LTS pin, and production
  deploys for the founder.

## Progress (scope and evidence rules: docs/LAUNCH.md)

- [x] R0 Foundations — merged into `main` as `1fae714` (19 Oct 2026, 19:10 UTC); CI run
      39307060823; `release-verifier` PASS in round 5 (`d6f68f5`, PR #17)
- [ ] R1 Private beta
- [ ] R2 Public launch
- [ ] Launch extras (LAUNCH.md section B)
- [ ] Final evidence pack (LAUNCH.md section D)

## Waiting on founder

All founder inputs in LAUNCH.md section C are open, and by the founder's decision they come last:
builders do not wait for them. Each check that needs one goes into LAUNCH.md section E. Builders
keep this list to the inputs in the order the founder should add them at the end, each with the
command to run after it; `docs/FOUNDER_SETUP.md` has the steps.

Decided under the founder's delegation (19 Oct 2026, 19:04 UTC), no longer waiting on him: Shopify
App Store requirement 1.1.3 ("Your app must not allow merchants to download themes") rules out
the patched theme package, so that channel is retired and R2's package work is dropped. 5.1.1
("You or merchants should not make any code changes to the theme") puts the GitHub pull-request
channel at App Review risk, so it stays built behind its flag, off in the App Store build; at
submission the founder's account asks Shopify whether a pull request the merchant's developer
reviews and merges meets 5.1.1, and the flag turns on only with that answer in writing. Every
PLAN §5 exit criterion is unchanged. ADR-141's amendment records it at integration.

## Founder notifications sent

- None yet.

## Scheduled tasks

- Continuation check: `trig_01NTAnum1gJ3USsxJn3qPbJq` ("Rampsmith continuation check"), every
  2 hours at minute 24 UTC. It starts the next builder when none is active, notifies the founder
  when only founder inputs remain, and disables itself once the product is launch-ready.
- Original R0 builder: `trig_01PkdkTUzdELnYTsZEQQeuVW` ("Rampsmith R0 build"), already fired and disabled.
