-- R2 daily monitoring: regression records (PLAN §5 R2, ADR-310, ADR-311).
--
-- Expand only. After a scheduled scan is finalised, the engine compares it with the site's
-- previous completed scan and stores one `regressions` row for it: which findings are new,
-- which came back after being absent, and how the totals moved. A row exists for every
-- evaluated scan, with zero counts when nothing regressed, so the evaluation runs once.
-- Tenant-owned: row-level security on `tenant_id` and composite foreign keys (ADR-006, ADR-017).

create table regressions (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  scan_id uuid not null,
  previous_scan_id uuid,
  -- Open findings never seen before this scan.
  new_count integer not null check (new_count >= 0),
  -- Open findings seen in an earlier scan, absent from the previous one, and open again.
  reappeared_count integer not null check (reappeared_count >= 0),
  -- Distinct findings (best practices left out) the scan and the previous scan recorded.
  findings_seen integer not null check (findings_seen >= 0),
  previous_findings_seen integer check (previous_findings_seen >= 0),
  -- Checks passed over checks run, as a percentage; null when the scan ran no checks.
  pass_rate numeric(5, 2) check (pass_rate between 0 and 100),
  previous_pass_rate numeric(5, 2) check (previous_pass_rate between 0 and 100),
  -- The first findings, most severe first: [{finding_id, rule_id, impact, criteria, kind}].
  -- Capped by the writer; the counts above are the totals.
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  -- What happened to the alert email: `queued`, or why not (`not_applicable` when nothing
  -- regressed, `plan` when the plan has no regression alerts, `no_contact`).
  alert_state text not null check (alert_state in ('queued', 'not_applicable', 'plan', 'no_contact')),
  detected_at timestamptz not null default now(),
  -- The merchant dismissed the App Home banner.
  dismissed_at timestamptz,
  unique (scan_id),
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  foreign key (scan_id, tenant_id) references scans (id, tenant_id),
  foreign key (previous_scan_id, tenant_id) references scans (id, tenant_id),
  check (previous_scan_id is distinct from scan_id)
);
create index regressions_site_detected on regressions (site_id, detected_at desc);
create index regressions_tenant on regressions (tenant_id);

alter table regressions enable row level security;
create policy tenant_isolation on regressions
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));

-- The engine and ctl (workers) write the rows and the redaction removes them; the api reads
-- them and records a dismissal. The app role may also insert, like every other tenant table,
-- because the restore drill seeds every table through it (ADR-175); row-level security confines
-- that to its own tenant, and no api route writes one.
grant select, insert, update, delete on regressions to rampsmith_worker;
grant select, insert, update on regressions to rampsmith_app;

-- ---------------------------------------------------------------------------------------
-- finding_occurrences: which findings a given scan recorded. The comparison asks this of two
-- scans; without an index it would read every occurrence of the tenant.
-- ---------------------------------------------------------------------------------------
create index finding_occurrences_scan on finding_occurrences (tenant_id, scan_id, finding_id);

-- ---------------------------------------------------------------------------------------
-- shop_billing: whether the plan includes regression alerts, written by
-- `db::repo::shop_billing::put` from `billing::entitlements` with the other limits the engine
-- enforces (audit M2, M3, ADR-096), so the engine never holds a second copy of the plan table.
-- ---------------------------------------------------------------------------------------
alter table shop_billing
  add column regression_alerts boolean not null default false;

-- Rows stored before this migration: Growth and Pro include the feature (PLAN §20).
update shop_billing set regression_alerts = true where effective_plan in ('growth', 'pro');
