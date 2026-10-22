# ADR-038: Wired stubs, so each R1 lane edits only the files it owns

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-018 (queue protocol), ADR-035, ADR-036, ADR-037

## Context

Three lanes build R1 in parallel from Phase 0 (STATUS, "R1 plan"). Every place where the
pipeline is wired together (the `ctl` worker registry, the engine's queue registry, the api's
route list and OpenAPI document, the workspace manifest) is a file two lanes would otherwise
edit at once. Each such edit is a merge conflict, and a conflict in `Cargo.lock` or `main.rs`
is the kind that gets resolved by guessing.

## Decision

Phase 0 wires every R1 entry point once, as a stub that fails in a typed, visible way. A lane
then replaces a stub body in a file only that lane owns.

1. **`ctl` (lane A).** `crates/ctl/src/jobs/mod.rs` registers `shopify.read_store`,
   `shopify.apply_data_fix`, `shopify.revert_data_fix` and `webhook.process`, one worker each
   (`main.rs` spawns them from `jobs::QUEUES`). `dispatch` hands a job to
   `jobs/<queue>.rs::handle(db, job)`. Each stub returns a permanent `Failure` with the code
   `not_implemented` and the queue in its message, so a job that arrives early is parked dead
   with a reason, never retried and never dropped. A queue outside the registry fails with
   `queue_unknown`. Lane A edits the four `jobs/<queue>.rs` files and adds modules beside them;
   `mod.rs` and `main.rs` do not change.
2. **Engine (lanes B and C).** `packages/engine/src/queues.ts` and `src/jobs/*.ts` (commit
   `238a043`) already register `scan.plan`, `scan.page`, `scan.finalize`, `audit.data`,
   `ai.alt_text` and `verify.scan`. Each handler validates its payload against the generated
   schema, then fails permanently with `not_implemented` until its lane replaces the body: lane B
   `plan.ts`, `finalize.ts`, `audit-data.ts`, `verify.ts` and `worker.ts`; lane C `alt-text.ts`.
3. **api (lane A).** `crates/api/src/r1.rs` declares the embedded app's routes under
   `/v1/shopify/` (overview, scans, findings, fixes with edit, approve, reject and undo,
   evidence, settings, statement), authenticated by `ShopSession`, answering 503 `unavailable`.
   They are registered in `lib.rs` and appear in `packages/contracts-ts/openapi/api.json`, so
   `apps/web` (lane C) can code against operation ids (`listFindings`, `approveFix`, ...) from
   the first day. Lane A fills in each handler and documents its request and response bodies,
   then regenerates `openapi/api.json` and `src/generated/api.ts`. A path may gain methods or
   parameters; an operation id is not renamed without telling lane C.
4. **Webhooks.** The webhook listener on `WEBHOOK_BIND_ADDR` (ADR-182) is lane A's, built with
   the verify, store and enqueue steps of PLAN §14 on top of `webhook_events` (ADR-037). It is
   not a stub here because it must be a separate router that serves nothing but `/webhooks/*`.
5. **`crates/shopify-admin`** is reserved with an `API_VERSION` constant (`2026-10`) and the
   `graphql_client` response type (ADR-039). Lane A fills it in; the workspace manifest and
   `Cargo.lock` already carry its dependencies.
6. **Isolation suite.** `crates/db/tests/tenancy.rs` covers the eight tables of ADR-037: a row
   per tenant in each, visibility, cross-tenant inserts, composite foreign keys, `ai_calls`
   append-only, the 30-day sweep and the sealed-password constraint. A lane that adds a tenant
   table adds it to `TENANT_TABLES` and `R1_TABLES` there.

## Consequences

- Lanes touch disjoint files; the shared wiring merges once, in Phase 0.
- Until a lane lands, the pipeline runs and fails loudly rather than silently doing nothing.
- A lane that needs a new queue or route is a scope change and goes through the architect.
- Lanes B and C add their own workspace dependency lines for `@rampsmith/a11y-rules`,
  `@rampsmith/ai` and `sharp` to `packages/engine/package.json` with `pnpm add` when they first
  import them. Phase 0 does not add them, because `knip` fails the gate on a dependency nothing
  imports yet.

## Rejected alternatives

- Each lane registers its own queues and routes: guaranteed conflicts in `main.rs`, `lib.rs`
  and the lock files.
- Stubs that return success: a pipeline that looks healthy and does nothing.
- Stubs that panic (`todo!`): denied by the lint policy, and a panic restarts a worker.
