# ADR-268: R1 integration decisions

- Status: Accepted
- Date: 2026-10-22

## Context

R1's lanes (the fix loop, the scan pipeline, the App Home and alt text) merged separately. The
integration pass closed the gaps between them. Four small decisions belong on record.

## Decision

- **`scan.page@1` is removed** from `crates/contracts` and its generated TypeScript. Nothing
  enqueues it; the engine already refused it (it parses `scan.page@2` only). ADR-036 versions
  payloads by suffix so a producer and a consumer can overlap during a deploy; with the producer
  gone and the queue empty in every environment, the old schema is dead weight. Reintroducing a
  `@1` would be a new ADR.
- **The scan's `ruleset_version` is set by the engine** when it plans, finalises and verifies a
  scan: `axe-core <version>; a11y-rules <hash>`, where the hash is a stable digest of the rule
  catalogue (`packages/a11y-rules/src/version.ts`). The api serves the stored value; only the
  placeholder `start_scan` writes (`axe-core`) falls back to the coverage document's axe version.
  A change to a custom rule's id, criteria, impact or kind changes the hash, so a finding can be
  tied to the rules that produced it.
- **The shop's name** is read in `shopify.read_store` (`shop { name }`) and stored in
  `shopify_shops.name` (nullable, 1 to 255 characters), refreshed by the `shop/update` webhook
  and cleared by `shop/redact`. The Overview's `shop.name` is that value, null before the first
  scan.
- **The sweep of store data** (`scan_inputs_sweep()`, ADR-035) existed and nothing called it.
  `ctl`'s leader now runs it, with the free-scan sweep, every 10 minutes.
- **The isolation suite checks itself.** `every_tenant_table_in_the_schema_is_in_the_isolation_suite`
  reads the catalogue (every table in `public` with row-level security or a `tenant_id`) and
  compares it with the list the suite exercises, so a new tenant table cannot be added without
  being added to the suite. It found `shop_billing` missing; it is covered now.
- **The approval lock is proven necessary.** Removing `lock_site` from `approve_fix` makes
  `twenty_approvals_at_once_pass_the_last_image_of_the_allowance_exactly_once` and
  `an_approval_waits_for_the_site_lock` fail 3 runs of 3; with the lock they pass 3 of 3
  (`docs/evidence/r1-integration.md`).

## Consequences

- A migration (`20261105000006`) adds `shopify_shops.name`; `20261105000007` adds the sealed
  scan password columns (ADR-266); `20261105000008` adds the free scanner's table and functions
  (ADR-267).
- The `.sqlx` cache and the generated contracts are regenerated in the same change.
