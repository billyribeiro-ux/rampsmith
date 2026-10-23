-- R2 agency view: organizations and the store links merchants grant them (ADR-313, ADR-314).
--
-- Expand only. An agency or company account is an `organization` with members (dashboard
-- users). It reaches a store only through a `store_links` row that the MERCHANT approved from
-- inside the embedded app, and only until either side revokes it. The agency never reads a
-- tenant's tables: `store_links` is tenant-owned with row-level security, so the dashboard's
-- identity transactions (no tenant set) see none of it, and the cross-store overview comes from
-- the security-definer functions below, each of which starts from the caller's memberships and
-- the live links and from nothing else (ADR-313).

-- ---------------------------------------------------------------------------------------
-- Organizations and members: not tenant-owned, like `users` (ADR-024). Reached through
-- `Db::identity()` only.
-- ---------------------------------------------------------------------------------------
create table organizations (
  id uuid primary key,
  name text not null check (length(name) between 1 and 100),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user on organization_members (user_id);

-- A request to link a store, made by an organization. Only the SHA-256 of the code is stored;
-- the code is shown to its creator once and typed into the app by the merchant. Single use,
-- one day.
create table agency_link_codes (
  id uuid primary key,
  organization_id uuid not null references organizations (id) on delete cascade,
  code_hash bytea not null unique check (length(code_hash) = 32),
  created_by uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index agency_link_codes_org on agency_link_codes (organization_id, created_at desc);

grant select, insert, update, delete on organizations, organization_members, agency_link_codes
  to rampsmith_app;

-- ---------------------------------------------------------------------------------------
-- store_links: the merchant's grant. Tenant-owned (ADR-006, ADR-017).
-- ---------------------------------------------------------------------------------------
create table store_links (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  shop_id uuid not null,
  organization_id uuid not null references organizations (id) on delete cascade,
  code_id uuid references agency_link_codes (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Who ended it: the merchant (App Home) or the agency (dashboard).
  revoked_by text check (revoked_by in ('merchant', 'agency')),
  unique (id, tenant_id),
  foreign key (shop_id, tenant_id) references shopify_shops (id, tenant_id),
  check ((revoked_at is null) = (revoked_by is null))
);
-- One live link per store and organization.
create unique index store_links_live on store_links (shop_id, organization_id) where revoked_at is null;
create index store_links_org on store_links (organization_id) where revoked_at is null;
create index store_links_tenant on store_links (tenant_id);

alter table store_links enable row level security;
create policy tenant_isolation on store_links
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));

-- The app role approves and revokes under its tenant; workers only remove rows on redaction.
grant select, insert, update on store_links to rampsmith_app;
grant select, insert, update, delete on store_links to rampsmith_worker;

-- ---------------------------------------------------------------------------------------
-- What the merchant sees before approving: the organization that made the code. Needs a
-- tenant (a verified Shopify session), returns nothing for an unknown, used or expired code.
-- ---------------------------------------------------------------------------------------
create function agency_preview_code(p_code_hash bytea)
  returns table (organization_name text, expires_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select o.name, c.expires_at
    from agency_link_codes c
    join organizations o on o.id = c.organization_id
   where c.code_hash = p_code_hash
     and c.used_at is null
     and c.expires_at > now()
     and (select app_current_tenant()) is not null
$$;

-- ---------------------------------------------------------------------------------------
-- The merchant approves: consumes the code and records the link for the caller's own shop.
-- Returns the link id, or null when the code is unknown, used or expired. Raises when the
-- tenant argument is not the transaction's tenant, so a caller cannot grant for another shop.
-- ---------------------------------------------------------------------------------------
create function agency_approve_link(p_tenant uuid, p_shop uuid, p_code_hash bytea, p_link uuid)
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_code agency_link_codes%rowtype;
  v_existing uuid;
begin
  if p_tenant is distinct from (select app_current_tenant()) then
    raise exception 'tenant mismatch' using errcode = '42501';
  end if;
  if not exists (select 1 from shopify_shops where id = p_shop and tenant_id = p_tenant
                    and status = 'installed') then
    raise exception 'unknown shop' using errcode = '42501';
  end if;
  select * into v_code from agency_link_codes
   where code_hash = p_code_hash and used_at is null and expires_at > now()
   for update;
  if not found then
    return null;
  end if;
  update agency_link_codes set used_at = now() where id = v_code.id;
  select id into v_existing from store_links
   where shop_id = p_shop and organization_id = v_code.organization_id and revoked_at is null;
  if v_existing is not null then
    return v_existing;
  end if;
  insert into store_links (id, tenant_id, shop_id, organization_id, code_id)
  values (p_link, p_tenant, p_shop, v_code.organization_id, v_code.id);
  return p_link;
end
$$;

-- ---------------------------------------------------------------------------------------
-- The cross-store overview: one row per live link of every organization the user belongs to.
-- It starts from the user's memberships and live links; a store with no live link is never
-- selected. It returns counts and dates, no finding content and no personal data.
-- ---------------------------------------------------------------------------------------
create function agency_linked_stores(p_user uuid)
  returns table (
    link_id uuid,
    organization_id uuid,
    organization_name text,
    shop_domain text,
    granted_at timestamptz,
    scan_status text,
    scan_trigger text,
    scan_at timestamptz,
    checks_run integer,
    checks_passed integer,
    open_findings integer,
    open_serious integer,
    regression_new integer,
    regression_reappeared integer,
    regression_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select l.id, o.id, o.name, s.shop_domain, l.granted_at,
         sc.status, sc.trigger, coalesce(sc.finished_at, sc.created_at),
         sc.checks_run, sc.checks_passed,
         coalesce(f.open_total, 0)::integer, coalesce(f.open_serious, 0)::integer,
         r.new_count, r.reappeared_count, r.detected_at
    from organization_members m
    join organizations o on o.id = m.organization_id
    join store_links l on l.organization_id = m.organization_id and l.revoked_at is null
    join shopify_shops s on s.id = l.shop_id and s.tenant_id = l.tenant_id
                        and s.status = 'installed'
    left join lateral (
      select x.status, x.trigger, x.finished_at, x.created_at, x.checks_run, x.checks_passed
        from scans x
       where x.tenant_id = l.tenant_id and x.site_id = s.site_id and x.trigger <> 'verify'
       order by x.created_at desc limit 1
    ) sc on true
    left join lateral (
      select count(*) as open_total,
             count(*) filter (where y.impact in ('serious', 'critical')) as open_serious
        from findings y
       where y.tenant_id = l.tenant_id and y.site_id = s.site_id
         and y.status = 'open' and not y.best_practice
    ) f on true
    left join lateral (
      select z.new_count, z.reappeared_count, z.detected_at
        from regressions z
       where z.tenant_id = l.tenant_id and z.site_id = s.site_id
         and z.dismissed_at is null and z.detected_at > now() - interval '30 days'
         and z.new_count + z.reappeared_count > 0
       order by z.detected_at desc limit 1
    ) r on true
   where m.user_id = p_user
   order by o.name, s.shop_domain
$$;

-- ---------------------------------------------------------------------------------------
-- The agency ends a link: only a member of the link's organization can.
-- ---------------------------------------------------------------------------------------
create function agency_unlink(p_user uuid, p_link uuid)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_done integer;
begin
  update store_links l
     set revoked_at = now(), revoked_by = 'agency'
   where l.id = p_link and l.revoked_at is null
     and exists (select 1 from organization_members m
                  where m.organization_id = l.organization_id and m.user_id = p_user);
  get diagnostics v_done = row_count;
  return v_done = 1;
end
$$;

revoke all on function agency_preview_code(bytea) from public;
revoke all on function agency_approve_link(uuid, uuid, bytea, uuid) from public;
revoke all on function agency_linked_stores(uuid) from public;
revoke all on function agency_unlink(uuid, uuid) from public;
grant execute on function agency_preview_code(bytea) to rampsmith_app;
grant execute on function agency_approve_link(uuid, uuid, bytea, uuid) to rampsmith_app;
grant execute on function agency_linked_stores(uuid) to rampsmith_app;
grant execute on function agency_unlink(uuid, uuid) to rampsmith_app;
