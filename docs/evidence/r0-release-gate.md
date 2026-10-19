# Evidence: the R0 release gate

R0 (PLAN §5) merges to `main` only when GitHub Actions is green on the pinned toolchains and the
`release-verifier` subagent returns PASS (CLAUDE.md). This file records both rounds.

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

## Round 2 verdict

Recorded below by the architect after the `release-verifier` run.
