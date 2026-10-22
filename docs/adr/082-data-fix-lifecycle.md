# ADR-082: The data-fix lifecycle: approve, apply, verify, undo

- Status: Accepted
- Date: 2026-10-22
- Refines: PLAN §5 (R1 "What each fix must carry"), §12; ADR-004, ADR-035

## Decision

A data fix is a `fixes` row (`kind data`, `channel admin_api`) with a `diff` and a
`data_fix_snapshots` row (`resource_gid`, `field`, `before_value`, `after_value`; JSON `null` is an
unset field). Fixes write only: media alt text (`fileUpdate`), product and collection descriptions
(`productUpdate`, `collectionUpdate`) and page bodies (`pageUpdate`). Never a theme file (ADR-004).

States: `proposed`, `approved`, `applying`, `applied`, `verified`, `failed`, `reverted`, `rejected`.
Every move is a conditional update, so two workers cannot both win.

- **Approval.** The embedded app's approver is a Shopify staff member, whose session token `sub` is
  not a Rampsmith user. `fixes.approved_by_ref` holds it; `approved_at` needs `approved_by` or
  `approved_by_ref`, not both (migration `20261103000001`). The api sets `approved` and queues the job.
- **Apply** (`shopify.apply_data_fix@1`). Refuse a fix with no approval record. Store the snapshot
  if the proposal did not, move `approved` to `applying`, commit. Read the live value: equal to
  `before` writes; equal to `after` means an earlier attempt wrote it; anything else means the
  merchant changed it, so the fix fails with `conflict_value_changed` and nothing is written.
  After the write the owning resource (product, collection or page) is read again; one transaction
  marks the fix `applied`, creates a `verify` scan, stores the re-read resource as a `verify`
  input (batch shape of ADR-081, with `kind`), queues `verify.scan@1` and writes the audit entry
  (resource, field, approver, approval time; never the values).
- **Failure.** A retryable error (outage, throttling, image still processing) leaves the fix
  `applying` and retries; resuming is safe because of the live-value rule. `userErrors`, a deleted
  resource, a missing scope and a rejected token fail the fix with `shopify_rejected`,
  `resource_gone`, `scope_missing`, `token_rejected`.
- **Undo** (`shopify.revert_data_fix@1`). Only `applied` or `verified`. If the live value still
  equals `after`, write `before` (an empty string restores an unset alt text), move to `reverted`,
  set `reverted_at`, reopen the findings the fix had closed. If it equals `before` already, finish
  without writing. Otherwise refuse with `conflict_live_value_changed`, leave the fix as it was and
  record `shopify.data_fix_revert_refused`.

## Consequences

- `shop/redact` deletes snapshots (store content); the audit entries stay.
- Verification and the `verified` status belong to the engine (`verify.scan@1`).
