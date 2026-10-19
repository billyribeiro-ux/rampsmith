# ADR-037: The R1 schema, expand only

- Status: Accepted
- Date: 2026-10-19
- Builds on: ADR-017 (tenant keys), ADR-021 (sealed secrets), ADR-035, ADR-036

## Context

R1's three lanes (fix loop, scan pipeline, App Home) share tables. If each lane wrote its own
migration for shared tables, two lanes would alter `findings` or `fixes` in parallel and the
second merge would fail or, worse, apply in an order nobody tested. Phase 0 therefore lands one
migration, `20261102000001_r1_pipeline.sql`, before the lanes start.

## Decision

1. **Expand only.** The migration adds tables and adds columns that are nullable or carry a
   default, so everything on `main` keeps working unchanged. A change that needs code changed in
   the same commit (the `scan_pages` unique key gaining the viewport, a column becoming
   `not null`) belongs to the lane that changes that code, in that lane's migration block
   (STATUS: A `20261103*`, B `20261104*`, C `20261105*`).
2. **New tenant tables:** `scan_inputs`, `evidence`, `data_fix_snapshots`, `statements`,
   `ai_calls`, `ai_budgets`, `ai_reservations` and `webhook_events`. Each has `tenant_id`, composite
   foreign keys to its parents (ADR-017), row-level security with the `tenant_isolation`
   policy, and grants to `rampsmith_app` and `rampsmith_worker` only. `ai_calls` is
   insert-and-read, like the audit log.
3. **Store data for scans** (`scan_inputs`, ADR-035) holds what `ctl` read through the Admin API:
   ids, titles, alt text, rich text and menus, never a token, a header or customer data. It is
   swept after 30 days by `scan_inputs_sweep()`, a security definer with the age fixed in its
   body: a parameter would let any worker login, the engine included, delete every tenant's
   recent inputs.
4. **Evidence crops sit in PostgreSQL in R1** (`evidence`, at most 64 KiB, PNG or WebP), served
   by the api from its own origin. Moving them to object storage later is a new column and a
   copy job, not a contract change.
5. **The storefront password** of a password-protected development store is sealed like the
   Shopify tokens (ADR-021): `sites.storefront_password_ct` and `storefront_password_key_id`,
   both null or both set. It is never stored, logged or sent in plaintext.
6. **Webhooks** (`webhook_events`) are stored once verified, deduplicated by Shopify's event id,
   and processed from the table by `webhook.process`, which clears the body afterwards. The event
   id header is not covered by the HMAC, so a captured delivery can come back under a new id
   (integration audit M1). The table keeps `body_sha256` after the body is cleared, and lane A's
   handlers are idempotent or re-read state from Shopify before acting (an `app/uninstalled`
   replay for a shop that reinstalled must not uninstall it). The hash is indexed but not unique:
   Shopify can legitimately send the same body twice (a second `shop/redact` after a reinstall
   and uninstall), and that one must still be processed.
7. **Ranking and coverage live on the rows they describe:** `findings.priority_score`,
   `templates_affected`, `on_purchase_path` and `origin` (render or data); `scans.checks_run`,
   `checks_passed` and `coverage` for the coverage disclosure (ADR-225); `fixes.edited` for the
   R1 measure of drafts approved unedited.

## Consequences

- The isolation suite in `crates/db` covers the new tables through its catalog checks (tenant
  columns never null, RLS on every tenant table), so a lane that adds a tenant table without RLS
  fails CI.
- Lanes read these columns through `TenantTx` (Rust) or `withTenant` (TypeScript) only.

## Rejected alternatives

- One migration per lane for shared tables: merge-order bugs between parallel lanes.
- Evidence in R2 object storage now: a second credential for every service that shows a crop,
  before R1 needs one.
- A unique body hash for webhooks: it would drop a legitimate repeated compliance request.
