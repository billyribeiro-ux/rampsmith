-- The R1 fix loop (PLAN §5 R1 "What each fix must carry", §12; ADR-082, ADR-083).
--
-- Expand only, like 20261102000001: columns that are nullable, and one check that is relaxed.

-- ---------------------------------------------------------------------------------------
-- fixes: who approved. An embedded-app approval comes from a Shopify staff member, whose
-- session token `sub` is a Shopify user id, not a Rampsmith user (a UUID). It is kept as
-- `approved_by_ref`, and `approved_at` needs one of the two (ADR-082). `reverted_at` is when
-- a one-click undo restored the snapshot.
-- ---------------------------------------------------------------------------------------
alter table fixes
  add column approved_by_ref text check (char_length(approved_by_ref) between 1 and 100),
  add column reverted_at timestamptz,
  drop constraint fixes_check2,
  add constraint fixes_approver_present
    check ((approved_at is null) = (approved_by is null and approved_by_ref is null)),
  add constraint fixes_approver_single check (approved_by is null or approved_by_ref is null),
  add constraint fixes_reverted_status check (reverted_at is null or status = 'reverted');

-- `shop/redact` (ADR-080) deletes everything a shop's scans and AI calls recorded. Only the
-- worker role does it; the web role still cannot delete these rows.
grant delete on scan_pages, ai_calls to rampsmith_worker;

-- A delivery id identifies a delivery to one tenant (ADR-080): the same id arriving for two
-- shops is two deliveries, and one tenant's id can never hide another tenant's event.
alter table webhook_events drop constraint webhook_events_external_id_key;
alter table webhook_events add constraint webhook_events_tenant_external_id_key
  unique (tenant_id, external_id);
