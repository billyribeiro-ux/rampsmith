# ADR-087: Lane A audit, the remaining fixes (M3, M4, L1 to L10)

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-080, ADR-083, ADR-084, ADR-131
- Fixes: lane A audit M3, M4 (server side), L1 to L10

## Context

ADR-085 (H1) and ADR-086 (M1, M2) closed the high and two of the mediums. This ADR records the
decisions behind the rest. The engine-side effective budget and draft allowance belong to the lane C
fixes (ADR-097).

## Decision

1. **M3, Partner API fairness** (`crates/api/src/plan.rs`, `crates/billing/src/sweep.rs`). A
   "no active plan" answer is cached for five minutes, like any confirmed plan. The redirect
   parameter `plan_handle` is only a reason to check sooner and no route reads it; it never grants a
   plan. Each shop takes at most three Partner API calls a minute from the shared pacer, so one
   shop that reloads in a loop cannot starve the others.
2. **M4, server side**. When `PartnerPlans::refresh` stores a different plan, it lowers the stored
   AI budget to the new plan's ceiling in the same transaction (a raise leaves the merchant's
   choice alone). Manual `startScan` is limited per plan per day (403 without a chosen plan, 429 over
   the limit). PLAN sets no numbers; they follow the cost of a render.
3. **L1**. The concurrent-approval tests take the site lock in a second transaction first, so a
   missing lock fails them every time instead of by chance.
4. **L2**. `apply_data_fix` records the failure on its last attempt (`refuse_fix`); uninstall moves
   fixes stuck in `approved` or `applying` to `failed` (`shop_uninstalled`).
5. **L3**. Undo cancels the fix's pending `verify.scan:<fix>` job in the revert transaction, and the
   engine's `verify` handler closes findings only while the fix is `applied`.
6. **L4**. The storefront password is a `SecretString` in the request type (secrecy `serde`
   feature). `ctl.rewrap` re-wraps `sites.storefront_password_ct` with the same compare-and-swap as
   tokens, `remaining` counts both, the rotation runbook and `master-key-usage.sql` list both.
7. **L5** (ADR-085): a primary key on the digest dedup key and `on conflict`.
8. **L6**. `shop_billing` is in `TENANT_TABLES` with a seeded row per tenant.
9. **L7**. Redaction also clears `jobs.payload` for the tenant and `shopify_shops.shop_gid`.
   `rampsmith_worker` no longer has DELETE on `ai_calls`. `ctl`'s login joins the new group
   `rampsmith_ctl` (itself a member of `rampsmith_worker`), the only role that may execute the
   security-definer function `redact_ai_calls()`, which deletes only the transaction's own tenant
   and refuses a transaction with no tenant. The engine's login (a plain worker member) can neither
   delete nor call it.
10. **L8**. No mail transport or send job exists (`packages/email` renders and validates only; SES is
    LAUNCH.md C row 7). The uninstall transaction therefore cannot queue `uninstallExport`; it records
    `export_email: not_queued_no_sender` in its audit entry, and LAUNCH.md section E has a row
    that closes the gap.
11. **L9**. The Partner API client follows no redirect, speaks HTTPS only and fails at build time
    instead of falling back to a default client.
12. **L10**. One actor format, `shopify:<sub>`, for every audit entry and for `approved_by_ref`. Undo
    needs a staff `sub` (403 without). A 403 does not confirm an uninstall (ADR-085 corrected
    ADR-080). The shop domain compares case-insensitively in the worker. The grant check asks
    `shop { id }`. ADR-083 now says the Admin read asks for the shop name but nothing stores it.

## Consequences

- `ctl` needs a login `IN ROLE rampsmith_ctl`; without it redaction fails with a permission error
  and retries. LAUNCH.md section E carries the row.
- Migration `20261105000005_r1_c_audit_limits.sql` was renamed from `...000001`, which two merged
  branches used; sqlx refused to apply both.
- `approved_by_ref` values written before this change are bare `sub`s; nothing reads the format.

## Rejected alternatives

- A separate database login per function for redaction only: roles are created by the founder's
  deploy, so a group role the `ctl` login joins costs one `IN ROLE` clause.
- Keeping DELETE on `ai_calls` and trusting the engine: the audit's point is that the cost record
  must survive a compromised engine.
