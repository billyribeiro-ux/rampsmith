-- Which shops are due their weekly rescan (ADR-279).
--
-- A merchant on a plan that includes weekly rescans can switch them on (`sites.settings`,
-- `weekly_rescan`). The leader asks this function, for every tenant, which of those shops have
-- gone a week without a scan, and then starts each scan in an ordinary tenant transaction, where
-- it also checks the plan and the live-scan rule.
--
-- It is a security definer because the leader has no tenant when it asks, and it returns
-- identifiers only. A shop is due when it is installed, has the setting on, and has no scan
-- (other than the verification scans of a fix) that
--   - is queued, running or finished in the last 7 days, or
--   - was created in the last day, whatever came of it: a scan that failed is tried again
--     tomorrow, not on every tick.
-- Shops come in the order of their ids, `p_limit` at a time after `p_after`, so the leader pages
-- through all of them and a shop it skips (a plan that no longer includes weekly rescans) never
-- hides the shops behind it.
create function due_weekly_rescans(p_after uuid, p_limit int)
  returns table (tenant_id uuid, site_id uuid, shop_id uuid)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select sh.tenant_id, sh.site_id, sh.id
    from shopify_shops sh
    join sites si on si.id = sh.site_id and si.tenant_id = sh.tenant_id
   where sh.status = 'installed'
     and (p_after is null or sh.id > p_after)
     and si.settings -> 'weekly_rescan' = 'true'::jsonb
     and not exists (
       select 1 from scans sc
        where sc.tenant_id = sh.tenant_id
          and sc.site_id = sh.site_id
          and sc.trigger <> 'verify'
          and ((sc.status in ('queued', 'running', 'succeeded', 'partial')
                and sc.created_at > now() - interval '7 days')
               or sc.created_at > now() - interval '1 day')
     )
   order by sh.id
   limit greatest(p_limit, 0)
$$;

revoke all on function due_weekly_rescans(uuid, int) from public;
grant execute on function due_weekly_rescans(uuid, int) to rampsmith_worker;
