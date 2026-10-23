-- No sealed storefront-password copy outlives its scan or its installation (audit M3, ADR-283).
--
-- `scans.storefront_password_ct` holds a copy of a merchant's storefront password, sealed under
-- the scan key ring that the engine also holds (ADR-266). It is cleared when a scan finalises,
-- when a verification ends and when `scans::fail` runs. This migration closes the paths those
-- left open:
--
-- 1. An installation that ends: every scan of the tenant still queued or running is cancelled
--    with its copy cleared, whichever code path marked the shop as no longer installed
--    (the `app/uninstalled` handler, `shop/redact`, the operator's redaction).
-- 2. A backstop that needs no code path to be right: `scan_passwords_sweep()` clears any copy
--    older than an hour, and the `ctl` leader runs it with the other sweeps.

create function shops_end_scans_on_uninstall()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  update scans
     set status = 'cancelled', finished_at = now(), error_code = 'shop_uninstalled',
         storefront_password_ct = null, storefront_password_key_id = null
   where tenant_id = new.tenant_id and status in ('queued', 'running');
  return new;
end
$$;
revoke all on function shops_end_scans_on_uninstall() from public;

create trigger shopify_shops_end_scans
  after update of status on shopify_shops
  for each row
  when (old.status = 'installed' and new.status <> 'installed')
  execute function shops_end_scans_on_uninstall();

-- Clears sealed password copies more than an hour old, for every tenant. A scan lives minutes;
-- the age is fixed here so a worker login cannot use the function to clear a live scan's copy.
-- Returns how many copies it cleared.
create function scan_passwords_sweep()
  returns bigint
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  with cleared as (
    update scans set storefront_password_ct = null, storefront_password_key_id = null
     where storefront_password_ct is not null and created_at < now() - interval '1 hour'
    returning 1
  )
  select count(*) from cleared
$$;
revoke all on function scan_passwords_sweep() from public;
grant execute on function scan_passwords_sweep() to rampsmith_worker;
