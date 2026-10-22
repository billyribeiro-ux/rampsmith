-- State the embedded app's routes keep per shop (ADR-084): the plan Shopify confirmed.
-- Expand only. Every column is the stored form of `billing::BillingState`; the redirect
-- parameter `plan_handle` never writes here (audit M3), only a Partner API answer does.

create table shop_billing (
  shop_id uuid primary key,
  tenant_id uuid not null references tenants (id),
  standing text not null
    check (standing in ('unknown', 'no_active_plan', 'free_selected', 'free_subscription',
                        'paid', 'unrecognized')),
  plan text check (plan in ('free', 'starter', 'growth', 'pro')),
  plan_interval text check (plan_interval in ('monthly', 'yearly')),
  cancel_at_end_of_cycle boolean not null default false,
  trial_ends_at timestamptz,
  cycle_start timestamptz,
  cycle_end timestamptz,
  scheduled_plan text check (scheduled_plan in ('free', 'starter', 'growth', 'pro')),
  scheduled_interval text check (scheduled_interval in ('monthly', 'yearly')),
  unrecognized_handle text check (char_length(unrecognized_handle) <= 64),
  usage_anchor timestamptz,
  last_confirmed_at timestamptz,
  last_attempt_at timestamptz,
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  updated_at timestamptz not null default now(),
  foreign key (shop_id, tenant_id) references shopify_shops (id, tenant_id),
  -- A paid standing names a paid plan and an interval.
  check (standing <> 'paid' or (plan is not null and plan <> 'free' and plan_interval is not null))
);
create index shop_billing_tenant on shop_billing (tenant_id);

alter table shop_billing enable row level security;
create policy tenant_isolation on shop_billing
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
grant select, insert, update, delete on shop_billing to rampsmith_app, rampsmith_worker;

-- Shopify's own id for the shop (`gid://shopify/Shop/<n>`), which the Partner API names a shop
-- by. `shopify.read_store` records it from the Admin API; nothing else can know it.
alter table shopify_shops
  add column shop_gid text check (shop_gid ~ '^gid://shopify/Shop/[0-9]{1,18}$');
