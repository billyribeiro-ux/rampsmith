# Build status

Single source of truth for where the build stands and who is working. Every builder updates it.

Last updated: 2026-10-18 01:30 UTC by the builder `Rampsmith builder 2026-10-18 01:09 UTC`,
which stood down (below).

## Active builder

- The original "Rampsmith R0 build" session (`session_01Q33Wmz7em3UDGwr492j6SH`) is active on
  `r0-foundations` again. Its scheduled task reads FAILED (usage limit, 2026-10-17 23:25 UTC),
  but the session resumed and pushed `13e5a23`, `93c4419` and `4fdfb3b` (web `/healthz`,
  sandboxed engine self-check, web/engine/egress images, ADR-028 "service images") at
  2026-10-18 01:16 UTC. It works from R0-only instructions and does not read this file.
- Lock-rule gap: clause 1 does not see a resumed session whose task reads FAILED; clause 2 sees
  it only while it pushes. The builder `Rampsmith builder 2026-10-18 01:09 UTC`
  (`session_0141ZUbL5kywLHK6UAtS2pct`) registered at 01:12 UTC, when `r0-foundations` had had no
  push for 115 minutes, found the 01:16 push at 01:26 and stood down at 01:30 UTC. It built only
  the R0 required corrections, parked on branch `r0-corrections` (next section).
- The second-wave stream sessions (WS-6 to WS-13) stopped on usage limits between 23:25 and
  23:28 UTC; WS-11 has since resumed (`ws/corpus` pushed at 01:11 UTC, draft PR #2).

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

| Stream | Branch | Owns (no one else creates or edits these until merged) | ADRs | Status |
| --- | --- | --- | --- | --- |
| WS-1 Span patch engine (PLAN §12) | `ws/liquid-patch` | `packages/liquid-patch/` | 101–105 | Built at `551b200`: 117 tests, local gate green; no CI yet |
| WS-2 Custom rules and states (PLAN §11) | `ws/a11y-rules` | `packages/a11y-rules/`, `.github/workflows/a11y-rules.yml` | 111–116 | Built at `5bd9f99`: 80 unit + 24 browser tests, local gate green; no CI yet |
| WS-3 GitHub App (PLAN §15) | `ws/github-app` | `crates/github/`, `infra/github-app-manifest.json` | 121–127 | Built at `bb7703a`: 139 tests, local gate green on 1.97; security audit running |
| WS-4 Entitlements and App Pricing (PLAN §20) | `ws/billing` | `crates/billing/` | 131–134 | Built at `71977a3`: 105 tests, local gate green on 1.97; security audit running |
| WS-5 Launch documents (LAUNCH B, D) | `ws/launch-docs` | `docs/legal/`, `docs/threat-model.md`, `docs/accessibility-statement.md`, `docs/FOUNDER_SETUP.md`, `listing/` | 141–142 | Drafted at `083aedc`; its FOUNDER_SETUP.md merges onto main's version |

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

| Stream | Branch | Owns | ADRs | Status |
| --- | --- | --- | --- | --- |
| WS-6 Operator CLI: `rsctl doctor`, `rsctl keys generate` (LAUNCH B, E) | `ws/rsctl` | `crates/rsctl/` | 151–159 | Started |
| WS-7 Theme app extension (PLAN §14) | `ws/theme-app-ext` | `extensions/theme-app-ext/`, `packages/theme-app-ext-test/` | 161–169 | Started |
| WS-8 Runbooks, nightly backup, restore drill (PLAN §22, LAUNCH B) | `ws/ops` | New files in `docs/runbooks/` (not `shopify-dev-store.md`), `infra/backup/`, `infra/restore-drill/`, `.github/workflows/backup.yml`, `.github/workflows/restore-drill.yml` | 171–179 | Started |
| WS-9 Deployment as configuration (PLAN §22, §24, LAUNCH B) | `ws/deploy` | `infra/railway/`, `infra/collector/`, `.github/workflows/release.yml`, `.github/workflows/deploy.yml` | 181–189 | Started |
| WS-10 Email templates (LAUNCH B) | `ws/email` | `packages/email/` | 191–199 | Started |
| WS-11 Theme test corpus, synthetic themes only (PLAN §23) | `ws/corpus` | `corpus/`, `packages/corpus-tools/` | 201–209 | Started |
| WS-12 AI subsystem (PLAN §13) | `ws/ai` | `packages/ai/` | 211–219 | Started |
| WS-13 Reports and merchant statement generator (PLAN §5 R1, §16) | `ws/reports` | `packages/reports/` | 221–229 | Started |

## Coordination (founder decision, 17 Oct 2026)

- The founder confirmed the streams above. The session that opened them
  (`session_01VmdvAZ8qrHQ1rJJSj12mUg`) runs the streams and integrates the `ws/` branches. The
  architect chat (`session_01Xo2TExfkKEuqRyHUMqc1YC`) keeps plan and ADR decisions on `main`,
  LAUNCH.md, release verification and the founder's check-ins. Neither can message the other;
  this file is the channel.
- Every `ws/` branch starts from `e43f546`, which has none of `main`'s rules after `3eac5be`:
  LAUNCH.md (including section E), the Node 26 LTS rule (ADR-016), the pre-approvals and the
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

- **Node.js 26 LTS, a founder decision (17 Oct 2026; ADR-016).** It replaces the 24.22.0
  requirement recorded earlier that day. `r0-foundations` already runs 26.12.0, and its CI passed
  on it (run 39060459727). Since 17 Oct 2026, 22:37 UTC, releases may merge on 26.12.0 (founder
  decision; ADR-016 amendment, CLAUDE.md, PLAN §7 and the release-verifier updated on `main`),
  so the LTS release no longer blocks R0 or the streams. Before R0 merges:
  1. Add the `verify` check that fails when any Node pin disagrees with `.mise.toml`.
  2. Merge `main` into the branch. The branch already uses ADR-016 to ADR-018, so give main's
     Node runtime ADR (`docs/adr/016-node-26-lts-runtime.md`) the next free number: rename the
     file, update every reference to it (PLAN §6 and §7, CLAUDE.md, `docs/ENVIRONMENT.md`, this
     file, the release-verifier, both Node evidence files) and add it to `docs/adr/README.md`.
  3. Record the CI log's `node --version` in `docs/evidence/`.

  Steps 1 and 2 are done on branch `r0-corrections` (above), with ADR-029 as the new number,
  because `r0-foundations` took 028 for its service images. The release-verifier fails R0
  until all three are done. Follow-up, required before anything
  deploys and not before any merge: once the first 26.x release tagged LTS exists (due
  2026-10-28), pin it everywhere ADR-016 lists in one change; regenerate `pnpm-lock.yaml`; point
  ADR-014's sandbox binary at `node-linux-x64@<that version>`; replace the "first 26.x release
  tagged LTS" wording in ADR-016, PLAN §7 and §22, CLAUDE.md and `docs/ENVIRONMENT.md` with the
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

- [ ] R0 Foundations — in progress on `r0-foundations`
- [ ] R1 Private beta
- [ ] R2 Public launch
- [ ] Launch extras (LAUNCH.md section B)
- [ ] Final evidence pack (LAUNCH.md section D)

## Waiting on founder

All founder inputs in LAUNCH.md section C are open, and by the founder's decision they come last:
builders do not wait for them. Each check that needs one goes into LAUNCH.md section E. Builders
keep this list to the inputs in the order the founder should add them at the end, each with the
command to run after it; `docs/FOUNDER_SETUP.md` has the steps.

Decision needed, not an input: Shopify App Store requirement 1.1.3 ("Your app must not allow
merchants to download themes") and 5.1.1 ("You or merchants should not make any code changes to
the theme") put the patched theme package and the GitHub pull-request channel at App Review
risk. The architect recommends retiring the theme-package channel, keeping the pull-request
channel behind its flag, and asking Shopify before the R2 submission whether a pull request the
merchant's developer reviews and merges meets 5.1.1. Builders stop short of R2's package work
until the founder answers.

## Founder notifications sent

- None yet.

## Scheduled tasks

- Continuation check: `trig_01NTAnum1gJ3USsxJn3qPbJq` ("Rampsmith continuation check"), every
  2 hours at minute 24 UTC. It starts the next builder when none is active, notifies the founder
  when only founder inputs remain, and disables itself once the product is launch-ready.
- Original R0 builder: `trig_01PkdkTUzdELnYTsZEQQeuVW` ("Rampsmith R0 build"), already fired and disabled.
