# ADR-211: The AI logic lives in `packages/ai`; the engine's ai worker calls it

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §13)

## Context

PLAN §8 puts every Node worker in `packages/engine`, including the `ai` worker that runs the
`ai.alt_text`, `ai.fix_synthesis` and `ai.explain` queues (§10), and §13 puts the prompts in
`packages/engine/prompts/`. The second stream wave gave PLAN §13 to its own stream (WS-12)
while `packages/engine` stays with the main builder, so the AI work needs a home of its own
with a narrow, testable surface.

## Decision

1. **`packages/ai` (`@rampsmith/ai`) holds the AI logic and nothing else**: model routing,
   prompt construction and versioning, structured outputs and their validation, the alt-text
   rules, rewrites, source-mapping tie-breaks, patch proposals, rule explanations, retries,
   timeouts and the circuit breaker, the Message Batches lifecycle, cost accounting, the
   per-store budget guard, the data-handling rules, and the evaluation harness
   (`@rampsmith/ai/eval`). It has no database, queue or HTTP-server code.
2. **The engine's ai worker (main builder) calls it.** The worker claims a job, loads the
   inputs from the database inside a `TenantTx`, fetches the product image through `egress`
   and resizes it with `sharp` to the size `planImageResize` returns, then calls
   `prepareAltText` / `generateAltText`, `prepareRewrite`, `prepareTieBreak`,
   `preparePatchProposal` or `prepareExplanation`, either synchronously (`runCall`) or through
   `submitBatch` → `pollBatch` → `collectBatch` → `retireBatch`. It persists the results as
   `fixes` rows, maps an `AiError` onto the queue's `JobFailure` (`kind: retryable ?
   'retryable' : 'permanent'`, `{ code, message }`), writes each `AiCallRecord` to `ai_calls`,
   and implements `BudgetLedger` on PostgreSQL. While `CircuitBreaker.pausedUntil()` is set it
   stops claiming `ai.*` jobs; scans continue without AI drafts (PLAN §13).
3. **Dependencies**, each read from the npm registry on 2026-10-17 and pinned exactly:
   `@anthropic-ai/sdk` 0.135.0 (MIT; peer `zod` optional; published 2026-10-15),
   `ajv` 8.20.0 (MIT), `parse5` 8.0.1 (MIT; ADR-216), `@opentelemetry/api` 1.9.1
   (Apache-2.0, already in the workspace), the workspace's `@rampsmith/claims-lint` (its rules
   guard model output, ADR-213), and, for tests only, `vitest` 5.0.5 and
   `@opentelemetry/sdk-trace-base` 2.12.0 (Apache-2.0; peer `@opentelemetry/api` >=1.3.0
   <1.10.0; published 2026-10-06), which records the SDK's spans to prove they carry no
   content. `sharp` stays in the engine: its install script would need an entry in
   `pnpm-workspace.yaml`'s `allowBuilds`, a shared file this stream does not own.
4. **Release-age exception for the SDK.** `renovate.json` waits 7 days before proposing an
   upgrade (PLAN §18, compromised dependency). `@anthropic-ai/sdk` 0.135.0 was 2 days old when
   this stream adopted it; it is the version PLAN §7 pins, the current registry version, and
   has no advisories, and the security audit (LOW-9) asked for it to be pinned to 0.133.0 or
   recorded here. It stays at 0.135.0 because the rule governs Renovate's upgrades and PLAN §7
   chose this version; it qualifies under the rule from 2026-10-22, before this stream merges.
   The integrator re-checks the registry for an advisory before merging.
5. **The SDK is configured, not left to the environment.** The transport passes
   `openTelemetry: { propagation: false, traces: { enabled: true, contentMode:
   'metadata_only' } }` and `logLevel: 'off'`, so neither
   `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE` nor `ANTHROPIC_LOG` can put merchant text or
   model output into spans or logs, and no trace context leaves for Anthropic (security audit
   MEDIUM-4).
6. **Prompts move with the logic** to `packages/ai/prompts/<task>/v<N>.txt`, pinned by
   `prompts/manifest.json` (ADR-213).

## Consequences

- The AI subsystem is tested end to end without a database or network: 344 unit tests on
  fakes, recorded responses and a fake `fetch` behind the real SDK, plus 3 live checks that
  run only with `ANTHROPIC_API_KEY` (ADR-217).
- The engine owns persistence and orchestration, so a schema change for `ai_calls` or a budget
  table is one migration by the main builder (integration notes in
  `docs/evidence/ws-12-ai.md`).
- `@rampsmith/ai` imports `@rampsmith/claims-lint/src/scan.ts`, which works because
  claims-lint has no `exports` field. If it gains one, it must export `./src/scan.ts`.

## Plan correction

- PLAN §8 layout: add `packages/ai/  # AI subsystem: routing, prompts, outputs, costs,
  budgets, evaluation (ADR-211)` under `packages/`, and describe `engine` as "Node workers:
  scan, map, patch, ai (calls packages/ai), verify".
- PLAN §13 "Prompts and outputs", first bullet: "Prompts live in `packages/ai/prompts/` as
  versioned files" (was `packages/engine/prompts/`).
- PLAN §7 Engine table: add `parse5` 8.0.1 (MIT; heading and link spans in descriptions,
  ADR-216) and note that `@anthropic-ai/sdk` 0.135.0 and `ajv` 8.20.0 are used by
  `packages/ai`.

## Rejected alternatives

- AI code inside `packages/engine`: owned by the main builder in this wave, and it would tie
  pure logic to the worker's database and browser dependencies.
- A separate AI service: a new deployable and network hop for work that is a library call.
