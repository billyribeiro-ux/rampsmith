-- Core tables (PLAN §9), each isolated by tenant twice (ADR-006):
--
-- 1. Row-level security: `tenant_id = app_current_tenant()` on every read and write.
-- 2. Composite foreign keys `(x_id, tenant_id)`: a row can only reference rows of its own
--    tenant. Plain foreign keys are checked without row-level security, so without these a
--    bug could link one tenant's finding to another tenant's site (ADR-017).
--
-- Every table is tenant-owned. `tenant_id` is never nullable.

-- ---------------------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------------------
create table tenants (
  id uuid primary key,
  kind text not null check (kind in ('shopify_store', 'organization')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------------------
create table sites (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  platform text not null check (platform in ('shopify', 'wordpress', 'git', 'generic')),
  base_url text not null check (base_url ~ '^https://[^/\s]+'),
  verified_at timestamptz,
  verification_method text,
  primary_locale text not null default 'en',
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  check ((verified_at is null) = (verification_method is null))
);
create index sites_tenant on sites (tenant_id);

-- ---------------------------------------------------------------------------------------
-- shopify_shops and shopify_tokens
-- ---------------------------------------------------------------------------------------
create table shopify_shops (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  shop_domain text not null unique check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  scopes text[] not null,
  api_version text not null check (api_version ~ '^\d{4}-\d{2}$'),
  status text not null check (status in ('installed', 'uninstalled', 'redacted')),
  installed_at timestamptz not null,
  uninstalled_at timestamptz,
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id)
);
create index shopify_shops_tenant on shopify_shops (tenant_id);

-- Envelope-encrypted offline tokens. Never logged; plaintext never stored (PLAN §14).
create table shopify_tokens (
  shop_id uuid primary key,
  tenant_id uuid not null,
  access_ct bytea not null,
  refresh_ct bytea not null,
  key_id text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  version bigint not null default 0,
  foreign key (shop_id, tenant_id) references shopify_shops (id, tenant_id)
);
create index shopify_tokens_tenant on shopify_tokens (tenant_id);

-- ---------------------------------------------------------------------------------------
-- scans
-- ---------------------------------------------------------------------------------------
create table scans (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  theme_ref text,
  trigger text not null check (trigger in ('manual', 'scheduled', 'webhook', 'verify', 'free')),
  status text not null
    check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  ruleset_version text not null,
  pages_planned int not null default 0 check (pages_planned >= 0),
  pages_done int not null default 0 check (pages_done >= 0 and pages_done <= pages_planned),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id)
);
create index scans_site_started on scans (site_id, started_at desc);
create index scans_tenant on scans (tenant_id);

-- ---------------------------------------------------------------------------------------
-- findings and finding_occurrences
-- ---------------------------------------------------------------------------------------
create table findings (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  fingerprint bytea not null check (octet_length(fingerprint) = 32), -- SHA-256
  rule_id text not null,
  criteria text[] not null,
  impact text not null check (impact in ('minor', 'moderate', 'serious', 'critical')),
  status text not null
    check (status in ('open', 'fixed', 'needs_review', 'accepted_risk', 'false_positive')),
  source_location jsonb,
  first_seen_scan uuid not null,
  last_seen_scan uuid not null,
  occurrence_count int not null check (occurrence_count >= 0),
  unique (site_id, fingerprint),
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  foreign key (first_seen_scan, tenant_id) references scans (id, tenant_id),
  foreign key (last_seen_scan, tenant_id) references scans (id, tenant_id)
);
create index findings_site_status on findings (site_id, status);
create index findings_tenant on findings (tenant_id);

create table finding_occurrences (
  finding_id uuid not null,
  scan_id uuid not null,
  tenant_id uuid not null,
  page_url text not null,
  page_state text not null
    check (page_state in ('default', 'nav_open', 'cart_drawer', 'variant_changed', 'modal')),
  target text not null,
  html_excerpt text not null check (char_length(html_excerpt) <= 512),
  captured_at timestamptz not null,
  foreign key (finding_id, tenant_id) references findings (id, tenant_id),
  foreign key (scan_id, tenant_id) references scans (id, tenant_id)
) partition by range (captured_at);
create index finding_occurrences_finding on finding_occurrences (finding_id, captured_at desc);
create index finding_occurrences_tenant on finding_occurrences (tenant_id);

-- Monthly partitions in UTC, created ahead by the scheduler (PLAN §9) and here at install.
-- Security definer: creating a partition needs ownership of the parent table.
create function ensure_finding_occurrence_partitions(months_ahead int default 3) returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  first_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  month_start timestamptz;
  partition_name text;
begin
  if months_ahead < 0 or months_ahead > 24 then
    raise exception 'months_ahead must be between 0 and 24, got %', months_ahead;
  end if;
  for i in 0..months_ahead loop
    month_start := first_month + make_interval(months => i);
    partition_name := 'finding_occurrences_' || to_char(month_start at time zone 'utc', 'YYYY_MM');
    continue when to_regclass(partition_name) is not null;
    execute format(
      'create table %I partition of finding_occurrences for values from (%L) to (%L)',
      partition_name, month_start, month_start + interval '1 month'
    );
    -- The parent's policy does not apply to direct queries on a partition, so each partition
    -- carries its own, in case a privilege on it is ever granted.
    execute format('alter table %I enable row level security', partition_name);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = (select app_current_tenant()))
         with check (tenant_id = (select app_current_tenant()))',
      partition_name
    );
  end loop;
end
$$;
revoke all on function ensure_finding_occurrence_partitions(int) from public;
grant execute on function ensure_finding_occurrence_partitions(int) to rampsmith_worker;

select ensure_finding_occurrence_partitions(3);

-- ---------------------------------------------------------------------------------------
-- fixes and fix_findings
-- ---------------------------------------------------------------------------------------
create table fixes (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  kind text not null check (kind in ('data', 'code')),
  channel text not null check (channel in ('admin_api', 'github_pr', 'theme_package')),
  status text not null check (
    status in ('proposed', 'approved', 'applying', 'applied', 'verified', 'failed', 'reverted', 'rejected')
  ),
  origin text not null check (origin in ('rule', 'ai', 'human')),
  model text,
  prompt_version text,
  confidence numeric(4, 3) check (confidence >= 0 and confidence <= 1),
  diff jsonb,
  patch_key text,
  approved_by uuid,
  approved_at timestamptz,
  applied_at timestamptz,
  verified_scan uuid,
  reverts uuid,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  foreign key (verified_scan, tenant_id) references scans (id, tenant_id),
  foreign key (reverts, tenant_id) references fixes (id, tenant_id),
  -- Data fixes go through the Admin API; code fixes through a pull request or a package.
  check ((kind = 'data') = (channel = 'admin_api')),
  -- An AI-written fix always records the model and prompt that wrote it (PLAN §13).
  check ((origin = 'ai') = (model is not null and prompt_version is not null)),
  check ((approved_by is null) = (approved_at is null))
);
create index fixes_site_status on fixes (site_id, status);
create index fixes_tenant on fixes (tenant_id);

create table fix_findings (
  fix_id uuid not null,
  finding_id uuid not null,
  tenant_id uuid not null,
  primary key (fix_id, finding_id),
  foreign key (fix_id, tenant_id) references fixes (id, tenant_id),
  foreign key (finding_id, tenant_id) references findings (id, tenant_id)
);
create index fix_findings_finding on fix_findings (finding_id);
create index fix_findings_tenant on fix_findings (tenant_id);

-- ---------------------------------------------------------------------------------------
-- audit_log: append-only
-- ---------------------------------------------------------------------------------------
create table audit_log (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  actor_kind text not null check (actor_kind in ('user', 'system', 'shopify', 'github', 'operator')),
  actor_id text,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  subject_type text not null,
  subject_id uuid not null,
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index audit_log_tenant_at on audit_log (tenant_id, at desc);

-- No role is granted update or delete below; this trigger also stops the owner. Redaction
-- after `shop/redact` (PLAN §19) will get its own audited path in R2.
create function audit_log_reject_change() returns trigger
  language plpgsql
as $$
begin
  raise exception 'audit_log is append-only (% rejected)', tg_op
    using errcode = 'insufficient_privilege';
end
$$;
create trigger audit_log_no_update_or_delete
  before update or delete on audit_log
  for each row execute function audit_log_reject_change();
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_reject_change();

-- ---------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------
alter table tenants enable row level security;
create policy tenant_isolation on tenants
  using (id = (select app_current_tenant()))
  with check (id = (select app_current_tenant()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'sites', 'shopify_shops', 'shopify_tokens', 'scans', 'findings', 'finding_occurrences',
    'fixes', 'fix_findings', 'audit_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = (select app_current_tenant()))
         with check (tenant_id = (select app_current_tenant()))',
      t
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges: application roles read and write their tenant's rows; the audit log only
-- grows. Partitions are reached through the parent, so no role is granted them directly.
-- ---------------------------------------------------------------------------------------
grant select, insert, update on tenants to rampsmith_app, rampsmith_worker;
grant select, insert, update, delete on
  sites, shopify_shops, shopify_tokens, scans, findings, finding_occurrences, fixes, fix_findings
  to rampsmith_app, rampsmith_worker;
grant select, insert on audit_log to rampsmith_app, rampsmith_worker;
