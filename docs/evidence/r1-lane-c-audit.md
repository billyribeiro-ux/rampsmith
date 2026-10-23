# R1 lane C security audit: findings and fixes

Audit of the AI alt-text job and the embedded App Home (lane C). Verdict PASS with 3 medium and
6 low findings. Branch `r1-c-audit-fixes`. Decisions: ADR-096 to ADR-099.

## Findings and fixes

| Finding | Fix | Where | Tests |
| --- | --- | --- | --- |
| M1 prompt-injection flags dropped | The flags are stored with the draft diff, returned by the api (`AltTextChangeDto.flags`), shown on the card as an alert with a confirm checkbox, and approval of a flagged draft needs `confirm_flagged=true` (422 otherwise). A flag from the first pass escalates once to the stronger model and survives on the result. | `packages/engine/src/jobs/alt-text.ts`, `packages/ai/src/tasks/alt-text.ts`, `crates/api/src/r1.rs`, `apps/web/src/lib/app/components/FixCard.svelte`, `proxy.server.ts` | engine `alt-text.test.ts` (M1), ai `alt-text.test.ts`, api `a_flagged_draft_is_approved_only_with_an_explicit_confirmation`, web `proxy.server.test.ts`, Playwright `app-flagged.spec.ts` |
| M2 engine budget differs from the api's | The api stores the plan's limits with the plan (`shop_billing.effective_plan`, `ai_budget_max_micro_usd`, ...) from `billing::entitlements`; the engine reads them and spends `min(setting, ceiling)`. `alt_text_max_characters` outside 40 to 300 is ignored. | migration `20261105000002_r1_c_audit_limits.sql`, `crates/billing/src/stored.rs`, `crates/db/src/repo/shop_billing.rs`, `packages/engine/src/ai/allowance.ts` | db `storing_a_plan_stores_the_limits_the_engine_enforces`, billing unit test, engine `allowance.test.ts`, `alt-text.test.ts` (M2) |
| M3 draft allowance not enforced | Remaining allowance (Free 25 once, Starter 2,000, Growth 10,000, Pro 50,000 a month) is computed before the model call and re-checked under a per-tenant advisory lock with a hold row (`ai_draft_holds`). A spent allowance fails permanently (`ai_draft_allowance_exhausted`) on Free and defers to renewal on paid plans. `audit.data` queues no more jobs than the room left. | `packages/engine/src/ai/allowance.ts`, `jobs/alt-text.ts`, `jobs/audit-data.ts` | engine `allowance.test.ts` (including concurrent jobs against the last draft), `alt-text.test.ts` (M3), `pipeline.test.ts` (enqueue cap) |
| L1 libvips loaders | All loaders are blocked and only the buffer loaders needed are unblocked; TIFF dropped; pixel limit lowered to 25 million. | `packages/engine/src/ai/image.ts` | `test/ai/image.test.ts` (SVG and TIFF refused) |
| L2 status under the row lock | The finding status is re-read under the lock before the draft is stored. | `jobs/alt-text.ts` | `alt-text.test.ts` (L2) |
| L3 lease loss | The lease-loss `AbortSignal` is passed to `JobHandler`, `generateAltText` and the image download. | `jobs/payload.ts`, `ai/egress-fetch.ts`, `jobs/alt-text.ts` | `alt-text.test.ts` (L3) |
| L4 response bodies and media route | Bodies are cancelled on early returns; the media route has a per-address rate limit and an in-flight cap (429). | `apps/web/src/lib/app/media.server.ts`, `media-guard.server.ts`, `export.server.ts`, `routes/app/api/media/+server.ts` | `media.server.test.ts`, `media-guard.server.test.ts`, `export.server.test.ts` |
| L5 outages lose drafts | An outage, a rate limit or a missing key defers the job without spending an attempt (new `defer` failure kind in `@rampsmith/queue`). | `packages/queue/src/protocol.ts`, `worker.ts`, `jobs/alt-text.ts` | queue `protocol.test.ts`, `alt-text.test.ts` (L5) |
| L6 statement preview | One findings read per page view (cached by shop and page), a byte-length size check. | `export.server.ts`, `upstream.server.ts`, `routes/app/api/statement-preview/+server.ts` | `export.server.test.ts`, `reports.server.test.ts` |

## Consequences worth knowing

- The evaluation harness now escalates `sock-pack-injection` because the model flagged
  instruction-like text. The escalated request had no recording, so
  `packages/ai/eval/recorded/alt-text@2/sock-pack-injection.claude-sonnet-5-5.json` was authored
  in the same labelled way as the other recordings (provenance says "authored", not captured).
  The escalation rate moves from 0.25 to 0.3, 26 calls, 26 recordings. The live recording is
  still LAUNCH.md section E (Anthropic key).
- No bulk-approve endpoint exists on `main`, so "refuse bulk approval of flagged fixes" is met
  by the single-approval route being the only approval path,.
- The media guard keys by address. Production must set `ADDRESS_HEADER` and `XFF_DEPTH`;
  without them the guard sees the proxy's address.
- The Rust queue crate has no `defer` kind; only the TypeScript engine queue uses it.
- The migration backfills paid rows with the PLAN §20 constants; the api rewrites them on the
  next plan confirmation.

## Evidence (local, 2026-10-22)

- `cargo test -p rampsmith-db -p rampsmith-api` and the other workspace crates: all `ok`.
- `cargo fmt --all --check` clean; `cargo clippy --workspace --all-targets -- -D warnings` clean.
- Contracts regenerated into a temporary directory: identical to the committed files.
- `pnpm lint` (0 warnings), `pnpm format:check`, `pnpm knip`, `pnpm typecheck` (svelte-check 0 errors, 0 warnings): clean.
- Vitest against PostgreSQL: queue 20, engine 217 (1 skipped: the live Anthropic test, section E), ai 361 (3 skipped, live), web 217.
- Playwright `app-home` project: 60 passed, including the new `app-flagged.spec.ts`.
