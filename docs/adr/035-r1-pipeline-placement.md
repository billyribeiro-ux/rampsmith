# ADR-035: Where the R1 scan-and-fix pipeline runs

- Status: Accepted
- Date: 2026-10-19
- Amends: PLAN §10 (queues), §11 (data audit), §12 (verification), §16 (evidence storage)

## Context

R1 (PLAN §5) scans eight page types in four states, audits store data, drafts alt text, and
applies data fixes with verification and undo. PLAN §10 and §11 place the data audit and the
scan plan in the engine, which would read Shopify's Admin API.

The engine never holds a Shopify token or a master key, and that is deliberate. It runs
Chromium against untrusted storefronts (ADR-025, ADR-028), and `infra/railway/railway.py` gives
it no `RAMPSMITH_MASTER_KEYS` (ADR-182). Only `api` and `ctl` open sealed tokens, through
`ShopifyAuth::access_token` in `crates/shopify-auth`.

Evidence crops (PLAN §16) were planned for R2 object storage. In R1 that would need a SigV4
presigner in Rust, an `img-src` for the bucket in the embedded app's CSP, and LAUNCH.md row 6
before anything works.

## Decision

1. **Every Admin API call runs in `ctl`.** That covers the store read for a scan
   (`shopify.read_store`), the writes of approved data fixes and their undo
   (`shopify.apply_data_fix`, `shopify.revert_data_fix`), and the re-read that verification
   needs.
2. **`ctl` hands store data to the engine through `scan_inputs`.** `ctl` stores what it read in
   a tenant table, `scan_inputs` (kind, sequence, JSON payload; swept after 30 days). The engine
   reads it under row-level security (`scan.plan`, `audit.data`, `ai.alt_text`, `verify.scan`).
   No token or Admin response header is stored there.
3. **The engine owns the browser and the analysis**: page planning from stored data, page
   scans in states and viewports, the data audit through `packages/a11y-rules`, ranking and
   finalisation, and alt-text drafts through `packages/ai`, with images fetched through
   `egress`.
4. **Evidence crops live in PostgreSQL in R1** (`evidence`, at most 64 KiB per crop, tenant
   table). The api serves them to the embedded app from its own origin, so the CSP and the
   founder inputs do not change. Moving them to R2 object storage is an R2 task, once row 6
   exists.
5. **The first fix does not wait for the page scan.** After install, `ctl` reads the store,
   the engine audits its data, and alt-text drafts are proposed while the render scan runs in
   parallel. That is the path to the R1 exit criterion of a median install-to-first-fix under
   10 minutes.

## Consequences

- A compromised engine cannot change a store: it holds no token.
- The data audit sees exactly what `ctl` read, so a verification compares one snapshot with the
  next.
- `scan_inputs` and `evidence` are new tenant tables. The isolation suite covers them
  automatically (`crates/db/tests/tenancy.rs`), and each new repository function gets its own
  cross-tenant test.
- PLAN §10, §11, §12 and §16 change as described.

## Plan correction

- §10 queues: `shopify.read_store`, `shopify.apply_data_fix`, `shopify.revert_data_fix` and
  `webhook.process` run in `ctl`. `scan.plan`, `scan.page@2`, `scan.finalize`, `audit.data`,
  `ai.alt_text` and `verify.scan` run in the engine (ADR-036).
- §11 data audit: the input is read by `ctl` into `scan_inputs`; the engine never calls Shopify.
- §16 evidence: crops are stored in PostgreSQL in R1 and served by the api; R2 object storage
  follows in R2.

## Rejected alternatives

- Give the engine the master keys: it would put every merchant's token one browser exploit
  away.
- A synchronous api endpoint the engine calls for store data: it would couple the two services
  that PLAN §6 keeps apart, which talk only through the queue.
