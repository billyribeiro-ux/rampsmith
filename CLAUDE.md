# Rampsmith — project instructions for Claude Code

Rampsmith is a self-serve Shopify app (WordPress in phase 2, any Git-hosted site in phase 3)
that finds WCAG 2.2 AA failures and fixes them at the source. The full plan is
`docs/PLAN.md`: read the sections your task touches before writing code. §27 is the
execution protocol; §5 defines each release's exit criteria.

Current release: **R0 Foundations**, in the order listed in PLAN §27.

## Evidence rules
- Check every dependency's current version and peer ranges on the live registry
  (`npm view <pkg> version peerDependencies`, the crates.io API) before adding it. Never
  use a version from memory. TypeScript stays on 6.x until SvelteKit's peer range allows 7.
- Check every Shopify (Admin API 2026-10), GitHub and Claude API detail in the official docs
  at implementation time. If docs and PLAN.md disagree, docs win: write an ADR, fix the plan.
- Run spikes S-1 to S-5 (PLAN §11, §14) once their prerequisites exist; record the evidence
  before building anything that depends on them.

## Engineering standards (PLAN §8)
- TypeScript `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`.
- Zero warnings from `tsc`, `svelte-check`, ESLint and Clippy (`-D warnings`).
- Svelte 5 runes only; SvelteKit 3 `#lib` alias; Kit config lives in `vite.config.ts`.
- Rust edition 2024; `unsafe` forbidden; no `unwrap`/`expect` outside tests; `thiserror`
  in libraries, `anyhow` only in a binary's `main`.
- pnpm only, installed through mise; Node 26; Rust 1.99.1 via `rust-toolchain.toml`;
  PostgreSQL 18.
- Every tenant-owned table goes through `TenantTx` plus row-level security; the isolation
  suite must pass.
- Tests first for pure logic. `mise run verify` passes before every commit. Conventional
  Commits, one logical change per commit.

## Never
- Write merchant theme files through any API (ADR-004), or add an overlay or toolbar widget.
- Use a banned claim from PLAN §3 (compliant, lawsuit-proof, guaranteed, certified) anywhere.
- Disable, skip or loosen a gate to make it pass.
- Commit a secret, or log a token, storefront password or personal data.
- Scan an unverified site outside the free-scanner limits, or solve or evade a bot challenge.
- Use floating tags such as `latest` for images, actions or CDN scripts.

## Working style
- Drive the build yourself. Decide from evidence and record each decision as
  `docs/adr/NNN-title.md`. Do not ask the founder questions that research can answer.
- Stop and ask the founder only for: spending money, production deploys, App Store or
  WordPress.org submission, legal text, pricing, scope changes, destructive data operations.
- After each milestone, report in 10 lines or fewer: what shipped, gate results, decisions needed.
