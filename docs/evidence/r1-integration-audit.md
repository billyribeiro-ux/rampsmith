# R1 integration audit: fixes and evidence

Audit of PR #34 (merge `3be48f4`: free scanner ADR-267, storefront-password hand-off ADR-266) and
of the Chromium sandbox fallback (ADR-265). Verdict was FAIL: 1 high, 3 medium, 9 low. Branch
`r1-int-audit-fixes`. Environment: PostgreSQL 18 on a local port, Node 26.12.0, pnpm 12.14.0,
Rust stable (1.99), Chromium at `/opt/google/chrome/chrome`. CI run links are in `docs/STATUS.md`.

| Finding | Fix | Tests (command) |
| --- | --- | --- |
| H1 free scans in an unsandboxed Chromium | ADR-280. `queuesFor(sandbox)` (`packages/engine/src/queues.ts`) registers `free_scan.run` only with the sandbox `on`; the engine beats `free_scan_engines` every 15 s (`free-scan-beat.ts`, migration `20261108000001`); the api answers 503 "free scanner unavailable" first thing without a fresh beat (`crates/api/src/free_scan.rs`); the web server maps it to the not-connected state (`apps/web/src/lib/server/scanner/delegate.ts`). LAUNCH.md E row added; ADR-265 and ADR-267 amended; separate low-privilege service recommended, not built | `pnpm --filter @rampsmith/engine exec vitest run test/free-scan-gate.test.ts`; `cargo test -p rampsmith-api --test free_scan` (503 and nothing spent: no Cloudflare call, no row, no job; stale and fresh beats); `cargo test -p rampsmith-db --test free_scans`; `delegate.test.ts`; `tests/site-scanner-api.spec.ts` |
| L6 engine survives a dead browser | `exitWhenBrowserLost` (`packages/engine/src/lifecycle.ts`) exits 1 on `disconnected`; `/healthz` turns 503 first (`health.ts`) | `test/free-scan-gate.test.ts` |
