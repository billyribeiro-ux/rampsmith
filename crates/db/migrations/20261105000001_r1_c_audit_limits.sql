-- R1 lane C audit (M2, M3; ADR-096, ADR-097): the plan limits the engine enforces, in the same
-- row the api reads, and the holds that keep concurrent alt-text jobs inside the draft
-- allowance. Expand only.

-- The limits of the plan a shop is on, written by `db::repo::shop_billing::put` from
-- `billing::entitlements` every time the plan state is stored (a webhook, a redirect check,
-- the sweep: they all end in `put`). The engine reads these columns and never holds a
-- second copy of the plan table, so it cannot differ from what the api enforces and shows.
-- Defaults are Free's, which also covers a shop whose plan was never confirmed.
alter table shop_billing
  add column effective_plan text not null default 'free'
    check (effective_plan in ('free', 'starter', 'growth', 'pro')),
  add column ai_budget_max_micro_usd bigint not null default 500000
    check (ai_budget_max_micro_usd >= 0),
  add column alt_text_draft_limit integer not null default 25
    check (alt_text_draft_limit >= 0),
  -- Free's 25 drafts are granted once, ever; paid plans renew monthly (ADR-133).
  add column alt_text_draft_lifetime boolean not null default true;

-- Rows stored before this migration: the plan table at the time of writing (PLAN §20). Rows
-- written from now on carry what `entitlements` says.
update shop_billing set
  effective_plan = plan,
  ai_budget_max_micro_usd = case plan
    when 'starter' then 5000000 when 'growth' then 20000000 else 60000000 end,
  alt_text_draft_limit = case plan
    when 'starter' then 2000 when 'growth' then 10000 else 50000 end,
  alt_text_draft_lifetime = false
 where standing = 'paid' and plan in ('starter', 'growth', 'pro');

-- ---------------------------------------------------------------------------------------
-- ai_draft_holds: drafts a running alt-text job may still make. The job takes its hold under a
-- per-tenant advisory lock after counting `ai_calls` and the other holds, so two jobs cannot
-- both take the last draft. The hold is deleted when the job's calls are recorded; the expiry
-- covers a crash.
-- ---------------------------------------------------------------------------------------
create table ai_draft_holds (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  units integer not null check (units between 1 and 2),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index ai_draft_holds_tenant on ai_draft_holds (tenant_id, expires_at);

alter table ai_draft_holds enable row level security;
create policy tenant_isolation on ai_draft_holds
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
grant select, insert, update, delete on ai_draft_holds to rampsmith_app, rampsmith_worker;
