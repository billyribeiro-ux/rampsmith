# Rampsmith — instructions for every Claude Code session

**Mission:** deliver a launch-ready Rampsmith (the self-serve Shopify app that finds WCAG 2.2 AA
failures and fixes them at the source), built end to end and proven by test evidence.
"Launch-ready" is defined in `docs/LAUNCH.md`. The only things left to the founder are the
accounts, credentials and decisions listed there.

**Read first, every session:** `docs/STATUS.md` (where the build stands, who is working),
`docs/LAUNCH.md` (scope and founder inputs), `docs/ENVIRONMENT.md` (what this environment can
run, verified), then the `docs/PLAN.md` sections for your task. PLAN §27 is the execution protocol.

## One builder at a time
- Before building, apply the lock rule in `docs/STATUS.md`. If another builder is active, do not build.
- Register your session in STATUS.md when you start. Push real progress at least every 45 minutes,
  with STATUS.md updated in the same commit.
- Release branches are `r<N>-<name>` from `main`. A release merges to `main` only when GitHub
  Actions is green on the pinned toolchains and the `release-verifier` subagent returns PASS.

## Evidence rules
- Check every dependency's current version and peer ranges on the live registry before adding it.
  Never use a version from memory. TypeScript stays on 6.x until SvelteKit's peer range allows 7.
- Check every Shopify (Admin API 2026-10), GitHub, Stripe and Claude API detail in official docs
  at implementation time. Docs beat PLAN.md: write an ADR in `docs/adr/` and correct the plan.
- "Done" needs evidence: the command, its output, or a CI run link, recorded in `docs/evidence/`.
- A skipped test is not a pass. A test that needs a founder input follows LAUNCH.md section E:
  a substitute test that passes now, a live test that skips with a notice naming the input, and
  a row in section E until it passes live.

## Effort
- Sessions run at `xhigh` (`.claude/settings.json`). The `release-verifier` and `security-auditor`
  subagents run at `max`: use them for every release gate and every change to auth, tokens,
  webhooks, `egress`, encryption or row-level security.

## Engineering standards (PLAN §8)
- Node.js 26 LTS everywhere, a founder decision; ADR-016 lists every pin. Pin the first 26.x
  release tagged LTS (due 28 October 2026). Until it exists, everything runs 26.12.0, and releases
  may merge on it (founder decision, 17 Oct 2026, 22:37 UTC); nothing deploys before the LTS pin.
  Changing the major line needs the founder.
- TypeScript `strict` plus the extra flags in PLAN §8. Zero warnings from `tsc`, `svelte-check`,
  ESLint and Clippy (`-D warnings`). Svelte 5 runes only; SvelteKit 3 `#lib` alias.
- Rust edition 2024; `unsafe` forbidden; no `unwrap`/`expect` outside tests; `thiserror` in
  libraries, `anyhow` only in a binary's `main`.
- Every tenant-owned table goes through `TenantTx` plus row-level security; the isolation suite passes.
- Tests first for pure logic. `mise run verify` passes before every commit. Conventional Commits.

## Never
- Write merchant theme files through any API (ADR-004), or add an overlay or toolbar widget.
- Use a banned claim from PLAN §3 (compliant, lawsuit-proof, guaranteed, certified) anywhere.
- Disable, skip or loosen a gate to make it pass.
- Commit a secret, ask for one in chat, or log a token, storefront password or personal data.
- Scan an unverified site outside the free-scanner limits, or solve or evade a bot challenge.
- Use floating tags such as `latest` for images, actions or CDN scripts.

## Founder boundary
- Stop and ask only for: spending money, production deploys, store submissions, publishing legal
  text, pricing changes, other scope changes, destructive data operations, and the founder inputs
  in LAUNCH.md.
- Pre-approved by the founder on 17 Oct 2026: the pricing in PLAN §20 as written; drafting legal
  text, always marked "attorney review required"; and evidence-backed scope tweaks that keep every
  PLAN §5 exit criterion, each recorded in an ADR.
- The founder's accounts come last (his decision, 17 Oct 2026): never wait for an input in
  LAUNCH.md section C. Build everything, and track each live check in section E.
- Write each request under "Waiting on founder" in STATUS.md, then keep working on everything else.
- Secrets reach the code only through GitHub Actions secrets and Railway variables that the founder sets.
