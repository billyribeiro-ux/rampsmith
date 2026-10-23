# ADR-283: No sealed storefront-password copy outlives its scan

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-266
- Source: audit of the R1 integration, finding M3 (and L9)

## Context

ADR-266 seals a copy of a protected store's password under the scan key ring, which the engine
also holds, in `scans.storefront_password_ct`. It said the copy is cleared when the scan finalises,
when a verification ends and when a scan fails, and that the 30-day sweep removes it with the scan.
The audit found otherwise: `scan_inputs_sweep()` deletes `scan_inputs` only, and a `scans` row is
kept; and several ways for a scan to end never touched the copy:

- an undo (`cancel_verification`) cancelled a queued `verify.scan` job and left its scan queued
  with the copy for ever;
- an uninstall (`end_installation`) ended the shop but left its queued and running scans;
- engine jobs that die without finishing the scan: `verify.scan` (a permanent failure, or a
  `page_load_failed` on the last attempt), `scan.plan`, `scan.finalize`, `audit.data` and a
  permanent `scan.page` failure.

## Decision

1. **Every terminal path ends the scan and clears the copy**, in the same statement:
   - `data_fixes::cancel_verification` also sets the cancelled job's scan (`payload.scan_id`) to
     `cancelled` (`verification_cancelled`) with the copy cleared (`crates/db/src/repo/data_fixes.rs`).
   - A trigger on `shopify_shops` (`shopify_shops_end_scans`, migration `20261108000002`) cancels
     every queued or running scan of the tenant, with its copy cleared (`shop_uninstalled`), when a
     shop stops being `installed`. It sits in the database, not in `end_installation`, so every
     path that ends an installation is covered, including the redaction handler and the operator's
     (`rsctl shops redact`), and the webhook lane's refactor of that function does not need to
     carry it.
   - The engine wraps `scan.plan`, `scan.finalize`, `verify.scan` and `audit.data` so that a
     permanent failure, or a retryable one on the last attempt, ends the scan as `failed` with
     the failure's code and clears the copy; `scan.page` does so on a permanent failure only (its
     last attempt records the page as failed and lets the scan finish with the other pages)
     (`packages/engine/src/jobs/scan-cleanup.ts`, wired in `queues.ts`).
2. **A backstop that needs no path to be right**: `scan_passwords_sweep()` (security definer,
   worker role, the age fixed at one hour in the function) clears any copy on a scan created more
   than an hour ago. `ctl`'s leader runs it with the other sweeps (`leader::sweep_scan_passwords`,
   every ten minutes), so no copy lives longer than about 70 minutes whatever fails. It clears the
   copy and does not change the scan's status: a scan older than an hour that is still running is
   already failing for another reason, and its next attempt reports the store as blocked.
3. **ADR-266 is corrected**: `scan_inputs_sweep` does not remove the copy (above); the re-wrap
   statement is corrected under L9 (the master-key re-wrap does cover the saved password).

## Consequences

- An attempt killed by the worker's deadline on its last attempt (ADR-282) cannot run the wrapper;
  the hourly sweep covers it.
- Tests: `crates/db/tests/scan_passwords.rs` (uninstall trigger, cancelled verification, sweep and
  its grants), `crates/ctl/tests/webhook.rs` (a real uninstall), `crates/ctl/tests/data_fix.rs`
  (an undo), `crates/ctl/tests/ctl.rs` (the leader's sweep), `packages/engine/test/scan-cleanup.test.ts`
  (each engine job: permanent, last attempt, `scan.page`'s exception).
