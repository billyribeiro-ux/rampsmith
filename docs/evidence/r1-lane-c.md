# R1 lane C evidence: App Home and AI alt text

Branch `r1-apphome`. Local gate on Node 26.12.0, pnpm 12.14.0, PostgreSQL 18.4 (embedded binaries,
docs/ENVIRONMENT.md). CI is authoritative.

## Increment 1: `ai.alt_text@1` (ADR-090)

- `npm view`: `sharp@0.35.5`, Apache-2.0, no install script, published 2026-09-27;
  `pnpm install` completed without an `allowBuilds` decision.
- `DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm --filter @rampsmith/engine exec vitest run`:
  13 files passed, 1 skipped; 143 tests passed, 1 skipped (the live check, "needs ANTHROPIC_API_KEY
  (LAUNCH.md section C, row 5)").
