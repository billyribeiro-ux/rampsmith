# Evidence: the R0 release gate

R0 (PLAN §5) merges to `main` only when GitHub Actions is green on the pinned toolchains and the
`release-verifier` subagent returns PASS (CLAUDE.md). This file records every round.

## Round 1: `7165c14`, verifier FAIL (19 Oct 2026)

All three PLAN §5 exit criteria passed, and CI was green at the head
([run 39273064507](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39273064507), 8 of 8
checks). The verifier's own local runs (Rust 1.97, PostgreSQL 18.4):

- Clippy `-D warnings` over the workspace: 0 warnings; fmt, cargo-deny, cargo-machete pass.
- ESLint `--max-warnings=0`, tsc, svelte-check (ui 466 files, web 1114 files: 0 errors, 0
  warnings), `vite build` without warnings.
- Queue kill test, Rust: `a_worker_killed_mid_job_loses_and_duplicates_nothing` passed, then 5
  more times; 23/23 queue tests. TypeScript: `survives a worker killed mid-job with no lost or
  duplicated job` passed, then 3 more times; 18/18.
- `packages/ui` browser tests: 33/33 (axe with the WCAG 2.2 A/AA tags, keyboard, focus ring,
  reduced motion).
- nextest 235/235, 0 skipped; no `.skip`, `.only`, `#[ignore]`, eslint-disable or TODO.

It failed six merge conditions. Each is now fixed:

| # | Blocker | Fix | Where |
| --- | --- | --- | --- |
| 1 | No live dev-store check, no LAUNCH.md section E row; code read `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` while LAUNCH.md row 1 says `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` | `crates/shopify/tests/live_dev_store.rs` sends an expired, correctly signed ID token to the store's real token endpoint and requires Shopify's documented 400 class (never rejected credentials); it skips with a notice naming C rows 1 and 3; section E row added; names aligned everywhere | ADR-031, ADR-032; `f1ec552` lane S1; LAUNCH.md `162bb1a` |
| 2 | Five hand-written inline SVG icons in `packages/ui` | `phosphor-svelte` 3.1.1 (`phosphor-svelte/lib/<Name>Icon`), decorative icons `aria-hidden`, `currentColor` | ADR-030; lane S1 |
| 3 | STATUS.md still pointed at ADR-016 for the Node rule | References moved to ADR-029; the remaining mentions are history ("first written as ADR-016") | `7cb9706` on `main` |
| 4 | ADR-029 and PLAN §6/§22 described an engine image that was not built; PLAN §22 said the api runs on distroless | ADR-029 amendment follows ADR-028 (Playwright image, Node's binary copied from the pinned official image); PLAN §6 row 029 and §22 `api`/`engine` rows corrected | `6bb8116` |
| 5 | The audit's follow-up (M1–M6, L1–L15) was not tracked | Lanes S2 (`r1-hardening`, draft PR #15) and S3 (`r1-hardening-ts`, draft PR #16) in STATUS.md "Builder team"; both merge after their own CI and `security-auditor` | `7cb9706` on `main` |
| 6 | Gate evidence not recorded | This file | — |

Also from lane S1: audit L3 (no redirects, HTTPS only for Shopify's token endpoint), L4 (error
classes matching Shopify's documentation: 400 stale ID token, 401 dead refresh token, 403
rejected credentials, 429/5xx transient), the L7 lines in `crates/shopify`, and L9 (WebAuthn
origin parsed as a URL; ADR-033).

## Round 2 input: CI at `7ac4568`

[Run 39296902197](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39296902197), pull
request #1, conclusion `success`: `rust`, `node`, `contracts`, `e2e`, `images (api)`,
`images (egress)`, `images (engine)`, `images (web)`. The `rust` job (Rust 1.99.1, PostgreSQL
18.6) ran the whole workspace under nextest, including the `rampsmith-shopify-auth` tests that
the sandbox could not run after the token error change, and posted this annotation:

```console
$ gh api repos/billyribeiro-ux/rampsmith/check-runs/118211649185/annotations \
    --jq '.[] | "\(.annotation_level): \(.title) — \(.message)"'
notice: Shopify dev-store live check skipped — Shopify dev-store live check skipped: needs LAUNCH.md section C rows 1 and 3 (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_DEV_STORE_DOMAIN)
```

So the live check runs in every CI run, skips visibly without the founder's inputs, and never
passes silently (LAUNCH.md section E, conditions 1 to 3).

Commits after `7ac4568` are documentation only: this file and a merge of `main`
(STATUS.md lanes, the LAUNCH.md section E row).

## Round 2: `659999d`, verifier FAIL (19 Oct 2026)

All three exit criteria passed again, CI was green on the head
([run 39298334697](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39298334697), 8 of 8),
and blockers 2 to 6 passed. Three things remained, each now fixed:

| # | Finding | Fix | Commit |
| --- | --- | --- | --- |
| 1 | The live test's header and the runbook said the probe proves the credentials; ADR-031 §3 says a 400 does not prove the secret | Both now say what ADR-031 §3 says; LAUNCH.md's section E row too | `40d86e2` |
| 2 | ADR-031 said CI would run the check once the inputs are GitHub secrets; `ci.yml` passes no secrets | ADR-031 corrected: the founder runs it (runbook section 3); a later live-checks workflow needs its own audit; FOUNDER_SETUP says so | `40d86e2` |
| 3 | No `security-auditor` record for lane S1's auth and token changes | Audit at effort max: **PASS**, seven lows (F5 fixed; F1–F4 and F6 owned by lane S2's follow-up, recorded in STATUS.md; F7 already fixed on lane S2's branch) and one medium outside the lane, O1 (fixed: the client secret no longer goes into GitHub repository secrets); `docs/evidence/r0-s1-security-audit-2026-10-19.md` | `0c4becc` |

CI at `40d86e2`: [run 39300708921](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39300708921),
8 of 8. Commits after it are documentation only.

## Round 3: `c6ff57d`, verifier FAIL (19 Oct 2026)

CI green on the head ([run 39303565668](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39303565668),
8 of 8); exit criteria and blockers 2 to 6 held. Six documentation items remained: the runbook
pointed at section 2 for the first install; four places said the live check proves the form,
which a status-only 400 cannot; the runbook said builders could run it; FOUNDER_SETUP gave
`rsctl doctor` to builders; the S1 audit's F1–F4 and F6 had no owning lane; this file
miscounted the S1 audit's findings. Fixed in `e94253e` (wording), `52e757d` and `2eebe07`
(STATUS.md: lane S2 owns the follow-ups) and merged as `6711218`.

## Round 4: `6711218`, verifier FAIL (19 Oct 2026)

CI green on the head ([run 39305484987](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39305484987),
8 of 8); every round 3 item passed except one sentence: the runbook stated that Shopify answers
a wrong secret with 400, which its documentation does not say (ADR-031 §3 hedges it, ADR-032
names 403 for bad credentials). Fixed by hedging that sentence and the test header's matching
line; the same commit gives runbook section 4 to the founder, wraps ADR-031 §3, and marks the
dated note in `r0-gate-fixes.md` as superseded.

Fix commits: `9280ddb` (the runbook and test-header hedges, the gate record) and `9c485fa`
(STATUS.md: lane S2 also owns the two `config.rs` files that F4 touches), merged as `ea4f1a1`.

## Round 5: `ea4f1a1`, verifier **PASS** (19 Oct 2026)

- CI on the head: [run 39307060823](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39307060823),
  `success`, 8 of 8 (`rust`, `node`, `contracts`, `e2e`, `images (api)`, `images (egress)`,
  `images (engine)`, `images (web)`), on Rust 1.99.1, Node 26.12.0 and PostgreSQL 18.6; the
  `rust` check run's only annotation is the live dev-store check's skip notice.
- PLAN §5 R0 exit criteria: zero warnings in Rust, TypeScript and Svelte; the queue survives a
  worker kill mid-job with no lost or duplicated job (Rust and TypeScript); the design
  primitives pass axe with zero violations. All PASS.
- Round 1's blockers 1 to 6, round 2's three items, round 3's six items and round 4's item: all
  PASS. The end-to-end read of runbook sections 3 and 4, LAUNCH.md's R0 row and ADR-031 found no
  sentence claiming more than the code and Shopify's documentation support.
- Node 26.12.0 everywhere ADR-029 lists; the 26.x LTS release is not out, so merging is allowed
  and deploying is not.
- Wording nits it listed as non-blocking (the `SHOPIFY_CLIENT` list in ADR-031 §1, one sentence in
  ADR-032's consequences, the runbook's error table, note 1 in `r0-gate-fixes.md`) are left for
  the next change to those files; STATUS.md's lane S2 cell is corrected on `main`.

Security: the R0 audit (`r0-security-audit-2026-10-19.md`) and the lane S1 audit
(`r0-s1-security-audit-2026-10-19.md`) both PASS; their medium findings are fixed (O1) or owned
by lanes S2 and S3 (M1 to M6, draft PRs #15 and #16).

After the PASS, only this record and ADR-034 (R0 merges with a merge commit so that the
branches built on it keep their history) were added; CI ran again on them before the merge.
