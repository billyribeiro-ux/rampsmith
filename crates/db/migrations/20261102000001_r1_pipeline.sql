-- The R1 scan-and-fix pipeline (PLAN §5 R1, §9, §11, §12, §13; ADR-035, ADR-036, ADR-037).
--
-- Expand only: new tables and new columns that are nullable or carry a default, so the code
-- already on `main` keeps working. Changes that need code changed at the same time (the
-- `scan_pages` unique key gaining the viewport) belong to the lane that changes that code.
-- Every new table is a tenant table: `tenant_id` with composite foreign keys (ADR-017),
-- row-level security with the `tenant_isolation` policy, and grants to the application roles
-- only.

-- ---------------------------------------------------------------------------------------
-- scans: the page plan, the checks counted for the coverage disclosure (ADR-225), and the
-- store-data inputs a scan waits for before it is finalised.
-- ---------------------------------------------------------------------------------------
alter table scans
  add column plan jsonb,
  add column checks_run int not null default 0 check (checks_run >= 0),
  add column checks_passed int not null default 0 check (checks_passed >= 0),
  add column data_inputs_planned int not null default 0 check (data_inputs_planned >= 0),
  add column data_inputs_done int not null default 0 check (data_inputs_done >= 0),
  add column coverage jsonb,
  add column finalized_at timestamptz,
  add constraint scans_checks_passed_within check (checks_passed <= checks_run),
  add constraint scans_inputs_done_within check (data_inputs_done <= data_inputs_planned);

-- ---------------------------------------------------------------------------------------
-- scan_pages: the page type and viewport of each loaded page, and how its state was reached.
-- R0's rows predate both, so the page type may be null; the viewport was always desktop.
-- ---------------------------------------------------------------------------------------
alter table scan_pages
  add column page_type text
    check (page_type in ('home', 'collection', 'product', 'cart', 'search', 'login', 'page', 'article')),
  add column viewport text not null default 'desktop' check (viewport in ('desktop', 'mobile')),
  add column state_outcome text
    check (state_outcome in ('opened', 'not_found', 'blocked', 'timed_out', 'error'));

-- ---------------------------------------------------------------------------------------
-- findings: where a finding came from, and its rank (PLAN §11 priority score).
-- ---------------------------------------------------------------------------------------
alter table findings
  add column origin text not null default 'render' check (origin in ('render', 'data')),
  add column priority_score numeric(12, 2) check (priority_score >= 0),
  add column templates_affected int not null default 0 check (templates_affected >= 0),
  add column on_purchase_path boolean not null default false;
create index findings_site_priority on findings (site_id, priority_score desc nulls last)
  where status = 'open';

-- ---------------------------------------------------------------------------------------
-- sites: merchant settings and the storefront password of a password-protected development
-- store, sealed like the Shopify tokens (ADR-021): ciphertext and key id, never plaintext.
-- ---------------------------------------------------------------------------------------
alter table sites
  add column settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object'),
  add column storefront_password_ct bytea,
  add column storefront_password_key_id text,
  add constraint sites_storefront_password_sealed
    check ((storefront_password_ct is null) = (storefront_password_key_id is null));

-- ---------------------------------------------------------------------------------------
-- shopify_shops: what `shopify.read_store` learns about the shop.
-- ---------------------------------------------------------------------------------------
alter table shopify_shops
  add column primary_domain text check (primary_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  add column locales text[] not null default '{}',
  add column synced_at timestamptz;

-- ---------------------------------------------------------------------------------------
-- scan_inputs: store data `ctl` read through the Admin API for the engine (ADR-035). Ids,
-- titles, alt text, rich text and menus only: never a token, a header or customer data.
-- Swept 30 days after it was read (`scan_inputs_sweep`).
-- ---------------------------------------------------------------------------------------
create table scan_inputs (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  scan_id uuid not null,
  site_id uuid not null,
  kind text not null
    check (kind in ('shop', 'products', 'collections', 'pages', 'articles', 'menus', 'verify')),
  seq int not null check (seq >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (scan_id, kind, seq),
  unique (id, tenant_id),
  foreign key (scan_id, tenant_id) references scans (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id)
);
create index scan_inputs_tenant on scan_inputs (tenant_id);
create index scan_inputs_created on scan_inputs (created_at);

-- ---------------------------------------------------------------------------------------
-- evidence: before and after crops of a finding (PLAN §5 "What each fix must carry"), kept in
-- PostgreSQL in R1 (ADR-035) and served by the api from its own origin.
-- ---------------------------------------------------------------------------------------
create table evidence (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  scan_id uuid not null,
  finding_id uuid,
  content_type text not null check (content_type in ('image/png', 'image/webp')),
  bytes bytea not null check (octet_length(bytes) between 1 and 65536),
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (scan_id, tenant_id) references scans (id, tenant_id),
  foreign key (finding_id, tenant_id) references findings (id, tenant_id)
);
create index evidence_tenant on evidence (tenant_id);
create index evidence_finding on evidence (finding_id);

-- ---------------------------------------------------------------------------------------
-- fixes: whether the merchant edited an AI draft before approving it (the R1 measure of
-- drafts approved unedited), why an attempt failed, when it was verified, and its evidence.
-- ---------------------------------------------------------------------------------------
alter table fixes
  add column edited boolean not null default false,
  add column error_code text check (error_code ~ '^[a-z][a-z0-9_]*$'),
  add column verified_at timestamptz,
  add column before_evidence_id uuid,
  add column after_evidence_id uuid,
  add constraint fixes_before_evidence
    foreign key (before_evidence_id, tenant_id) references evidence (id, tenant_id),
  add constraint fixes_after_evidence
    foreign key (after_evidence_id, tenant_id) references evidence (id, tenant_id),
  add constraint fixes_verified_has_scan check (verified_at is null or verified_scan is not null);

-- ---------------------------------------------------------------------------------------
-- data_fix_snapshots: the value a data fix replaces and the value it writes, so an apply can
-- check nothing changed since the proposal and an undo can check nothing changed since the
-- apply (PLAN §12, one-click undo).
-- ---------------------------------------------------------------------------------------
create table data_fix_snapshots (
  fix_id uuid primary key,
  tenant_id uuid not null,
  resource_gid text not null check (resource_gid ~ '^gid://shopify/[A-Za-z]+/[0-9]+$'),
  field text not null check (field ~ '^[a-z][a-z_]*$'),
  before_value jsonb not null,
  after_value jsonb not null,
  taken_at timestamptz not null default now(),
  foreign key (fix_id, tenant_id) references fixes (id, tenant_id)
);
create index data_fix_snapshots_tenant on data_fix_snapshots (tenant_id);

-- ---------------------------------------------------------------------------------------
-- statements: versions of the merchant's accessibility statement (PLAN §16; packages/reports,
-- ADR-221). A published version never changes; an edit is a new draft version.
-- ---------------------------------------------------------------------------------------
create table statements (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  version int not null check (version > 0),
  status text not null check (status in ('draft', 'published')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (site_id, version),
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  check ((status = 'published') = (published_at is not null))
);
create index statements_tenant on statements (tenant_id);

-- ---------------------------------------------------------------------------------------
-- ai_calls: metadata of each model call (PLAN §13, §19; packages/ai AiCallRecord). Never the
-- prompt or the output. Kept 13 months.
-- ---------------------------------------------------------------------------------------
create table ai_calls (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  task text not null check (task ~ '^[a-z][a-z_]*$'),
  model text not null check (model ~ '^claude-[a-z0-9-]+$'),
  mode text not null check (mode in ('sync', 'batch')),
  prompt_version text not null,
  input_tokens int not null check (input_tokens >= 0),
  output_tokens int not null check (output_tokens >= 0),
  cache_read_tokens int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens int not null default 0 check (cache_write_tokens >= 0),
  thinking_tokens int not null default 0 check (thinking_tokens >= 0),
  cost_micro_usd bigint not null check (cost_micro_usd >= 0),
  cost_is_estimate boolean not null,
  batch_id text,
  request_id text,
  outcome text not null
    check (outcome in ('ok', 'needs_review', 'refused', 'truncated', 'malformed', 'error')),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]*$'),
  attempts int not null check (attempts >= 1),
  duration_ms int not null check (duration_ms >= 0),
  started_at timestamptz not null
);
create index ai_calls_tenant_started on ai_calls (tenant_id, started_at desc);

-- ---------------------------------------------------------------------------------------
-- ai_budgets and ai_reservations: the per-store budget guard behind packages/ai's
-- BudgetLedger (reserve, settle, release), one row per tenant and budget period.
-- ---------------------------------------------------------------------------------------
create table ai_budgets (
  tenant_id uuid not null references tenants (id),
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  primary key (tenant_id, period)
);

create table ai_reservations (
  id uuid primary key,
  tenant_id uuid not null,
  period text not null,
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  state text not null check (state in ('reserved', 'settled', 'released')),
  actual_micro_usd bigint check (actual_micro_usd >= 0),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  foreign key (tenant_id, period) references ai_budgets (tenant_id, period),
  check ((state = 'settled') = (actual_micro_usd is not null)),
  check ((state = 'reserved') = (closed_at is null))
);
create index ai_reservations_tenant on ai_reservations (tenant_id);

-- ---------------------------------------------------------------------------------------
-- webhook_events: each verified Shopify webhook, deduplicated by Shopify's event id
-- (PLAN §14, §19). `webhook.process` reads the body from here, never from the request, and
-- clears it once processed. Webhooks for shops Rampsmith does not know are acknowledged and
-- not stored. The event id header is not covered by the HMAC, so a captured delivery can
-- come back under a new id: `body_sha256` (kept after the body is cleared) lets the handler
-- find a repeat, and every topic's handling is idempotent or re-reads state from Shopify
-- (ADR-037; integration audit M1).
-- ---------------------------------------------------------------------------------------
create table webhook_events (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  shop_id uuid not null,
  external_id text not null unique check (char_length(external_id) between 1 and 200),
  topic text not null check (topic ~ '^[a-z_]+(/[a-z_]+)+$'),
  body jsonb,
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (id, tenant_id),
  foreign key (shop_id, tenant_id) references shopify_shops (id, tenant_id),
  check (processed_at is null or body is null)
);
create index webhook_events_tenant on webhook_events (tenant_id);
create index webhook_events_body on webhook_events (tenant_id, topic, body_sha256);
create index webhook_events_unprocessed on webhook_events (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------------------
-- Row-level security and privileges for the new tables.
-- ---------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'scan_inputs', 'evidence', 'data_fix_snapshots', 'statements', 'ai_calls', 'ai_budgets',
    'ai_reservations', 'webhook_events'
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

grant select, insert, update, delete on
  scan_inputs, evidence, data_fix_snapshots, statements, ai_budgets, ai_reservations,
  webhook_events
  to rampsmith_app, rampsmith_worker;
-- Call metadata only grows, like the audit log.
grant select, insert on ai_calls to rampsmith_app, rampsmith_worker;

-- The 30-day sweep of store data read for scans (ADR-035). It runs for every tenant, so it is
-- a security definer. The age is fixed here, not a parameter, so a worker login (the engine is
-- one) cannot use it to delete another tenant's recent inputs. Returns how many rows went.
create function scan_inputs_sweep()
  returns bigint
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  with gone as (
    delete from scan_inputs where created_at < now() - interval '30 days' returning 1
  )
  select count(*) from gone
$$;

revoke all on function scan_inputs_sweep() from public;
grant execute on function scan_inputs_sweep() to rampsmith_worker;
