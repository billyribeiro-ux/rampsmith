# ADR-036: Job contracts of the R1 pipeline

- Status: Accepted
- Date: 2026-10-19
- Builds on: ADR-009 (generated contracts), ADR-018 (queue protocol), ADR-035

## Context

R1 needs ten new job payloads that cross the Rust/TypeScript boundary. ADR-009 requires one
source of truth per boundary: Rust types in `crates/contracts` that derive `JsonSchema`, with
TypeScript generated from the schemas and drift failing CI.

## Decision

1. The R1 payloads live in `crates/contracts/src/pipeline.rs`, each a strict
   (`deny_unknown_fields`) struct with its queue and versioned schema:
   `shopify.read_store@1`, `scan.plan@1`, `scan.page@2`, `scan.finalize@1`, `audit.data@1`,
   `ai.alt_text@1`, `verify.scan@1`, `shopify.apply_data_fix@1`, `shopify.revert_data_fix@1`
   and `webhook.process@1`. ADR-035 says which service runs each.
2. Payloads carry ids only (and the page URL and Shopify GID they act on). Bodies, tokens and
   store content stay in tenant tables, so a payload is never a place where data leaks.
3. The vocabulary (`PageType`, `Viewport`, `PageState`) is spelled as `crates/domain` and
   `packages/a11y-rules` spell it, and a test pins the strings. The enums are inlined into each
   schema, so the generated `index.ts`, which re-exports every file, never sees one name twice.
4. `scan.page@2` sits beside `scan.page@1` until the engine reads `@2` (R1 lane B). Then `@1`
   is removed in the same change that stops producing it. Nothing has been deployed, so no
   stored job holds `@1`.
5. Array bounds (`states`: 1 to 5, `urls`: 1 to 20) stay in the JSON Schema, where the engine's
   Ajv validation enforces them. The TypeScript generator ignores them (`ignoreMinAndMaxItems`),
   so arrays stay arrays instead of unions of tuples.

6. **The engine validates every payload against the generated JSON Schema** with Ajv 2020
   (`packages/engine/src/jobs/payload.ts`), so the Rust producer and the TypeScript consumer
   cannot drift. A mismatch fails the job permanently with `payload_invalid` and the failing
   keyword, never the value. `uuid`, `uri` (https only) and `uint32` are the formats the
   schemas use.
7. **One worker per queue** (`packages/engine/src/queues.ts`). A queue R1 has not built yet
   validates its payload and tenant, then fails permanently with `not_implemented`, so a job
   enqueued early stays visible as dead instead of disappearing. Each lane replaces its own
   stub in `packages/engine/src/jobs/`.

## Consequences

- Each job keeps its tenant in `jobs.tenant_id`; the ids in a payload must belong to it, and the
  workers check that before acting.
- Adding a field is a new schema version; the old one is accepted until no producer writes it.

## Rejected alternatives

- Grow `scan.page@1` with optional fields: a planner bug would silently scan in the default
  state only.
- One generic payload with a `kind` member: it would lose the per-queue strictness Ajv and
  serde give today.

> Update (R1 integration): `scan.page@1` was removed from the contracts; `scan.page@2` is the only page-scan payload. `free_scan.run@1` is added for the free scanner (ADR-267).
