-- One row per page and state a scan loaded (PLAN §9 supporting tables, §11). The unique key
-- makes recording a page idempotent: a `scan.page` job that runs again after a crash finds
-- its page already recorded and records nothing twice.
create table scan_pages (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  scan_id uuid not null,
  url text not null,
  page_state text not null
    check (page_state in ('default', 'nav_open', 'cart_drawer', 'variant_changed', 'modal')),
  http_status int,
  duration_ms int not null check (duration_ms >= 0),
  blocked_reason text check (blocked_reason in ('cloudflare', 'captcha', 'rate_limited')),
  violations int not null default 0 check (violations >= 0),
  scanned_at timestamptz not null default now(),
  unique (scan_id, url, page_state),
  foreign key (scan_id, tenant_id) references scans (id, tenant_id)
);
create index scan_pages_tenant on scan_pages (tenant_id);

alter table scan_pages enable row level security;
create policy tenant_isolation on scan_pages
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));

grant select, insert on scan_pages to rampsmith_app, rampsmith_worker;
