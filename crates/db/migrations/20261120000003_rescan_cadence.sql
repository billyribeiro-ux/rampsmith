-- R2 daily monitoring: scheduled rescans at the plan's cadence (PLAN §20, ADR-312).
--
-- Expand only. `due_weekly_rescans` (ADR-279) stays for the version of ctl that still calls it;
-- the leader moves to `due_scheduled_rescans`, which knows the plan's cadence (Free monthly,
-- Starter weekly, Growth and Pro daily), spreads shops with a fixed per-shop delay, and returns
-- shops fairly across tenants.

-- The plan's cadence, mirrored from `billing::entitlements` next to the other limits the engine
-- and ctl enforce (audit M2, M3, ADR-096), so SQL never holds a second copy of the plan table.
alter table shop_billing
  add column render_cadence text not null default 'monthly'
    check (render_cadence in ('monthly', 'weekly', 'daily'));

update shop_billing set render_cadence = case effective_plan
  when 'starter' then 'weekly'
  when 'growth' then 'daily'
  when 'pro' then 'daily'
  else 'monthly' end;

-- How long a shop waits between scheduled scans.
create function rescan_interval(p_cadence text)
  returns interval
  language sql
  immutable
  parallel safe
as $$
  select case p_cadence
    when 'daily' then interval '1 day'
    when 'weekly' then interval '7 days'
    else interval '30 days' end
$$;

-- The shops due a scheduled scan, most overdue first within each tenant's turn.
--
-- A shop is due when it is installed, has the setting on, and `rescan_interval(cadence)` plus its
-- own delay has passed since its last queued, running or finished scan. The delay is a fixed
-- share (up to a twelfth) of the interval derived from the shop id, so shops that were switched
-- on together do not all come due at the same minute. Verification scans of a fix do not count,
-- and a scan of any outcome in the last day (or in the last interval, if shorter) holds the next
-- one back, so a scan that failed is tried again tomorrow and not on every tick.
--
-- Fairness: shops are numbered within their tenant by how overdue they are, and the result is
-- ordered by that number first. The most overdue shop of every tenant comes before any tenant's
-- second one, and `p_per_tenant` caps one tenant's share of a round.
--
-- `p_only` asks about one shop, which is how the leader re-checks under the site's lock; the
-- answer is then the same rule at that moment, so a shop is started at most once per period.
create function due_scheduled_rescans(p_limit int, p_per_tenant int, p_only uuid default null)
  returns table (tenant_id uuid, site_id uuid, shop_id uuid)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with candidates as (
    select sh.tenant_id, sh.site_id, sh.id as shop_id,
           rescan_interval(coalesce(b.render_cadence, 'monthly')) as every,
           (select max(sc.created_at) from scans sc
             where sc.tenant_id = sh.tenant_id and sc.site_id = sh.site_id
               and sc.trigger <> 'verify'
               and sc.status in ('queued', 'running', 'succeeded', 'partial')) as last_scan
      from shopify_shops sh
      join sites si on si.id = sh.site_id and si.tenant_id = sh.tenant_id
      left join shop_billing b on b.shop_id = sh.id and b.tenant_id = sh.tenant_id
     where sh.status = 'installed'
       and (p_only is null or sh.id = p_only)
       and si.settings -> 'weekly_rescan' = 'true'::jsonb
  ),
  due as (
    select c.*,
           coalesce(c.last_scan, '-infinity'::timestamptz) + c.every
             + (extract(epoch from c.every) / 12.0
                * ((hashtextextended(c.shop_id::text, 0) & 2147483647)::float8 / 2147483647.0))
               * interval '1 second' as due_at
      from candidates c
     where not exists (
       select 1 from scans sc
        where sc.tenant_id = c.tenant_id and sc.site_id = c.site_id
          and sc.trigger <> 'verify'
          and sc.created_at > now() - least(c.every, interval '1 day')
     )
  ),
  ranked as (
    select d.tenant_id, d.site_id, d.shop_id, d.due_at,
           row_number() over (partition by d.tenant_id order by d.due_at, d.shop_id) as turn
      from due d
     where d.due_at <= now()
  )
  select r.tenant_id, r.site_id, r.shop_id
    from ranked r
   where r.turn <= greatest(p_per_tenant, 1)
   order by r.turn, r.due_at, r.shop_id
   limit greatest(p_limit, 0)
$$;

revoke all on function due_scheduled_rescans(int, int, uuid) from public;
grant execute on function due_scheduled_rescans(int, int, uuid) to rampsmith_worker;
