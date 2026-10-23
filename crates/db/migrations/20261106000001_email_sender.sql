-- Transactional email (ADR-270 to ADR-274): where a shop owner's address is kept, who must not be
-- written to, and what has been sent. Expand only: three new tables and one function.
--
-- None of the three holds a recipient address except `shop_contacts`, which is the one place an
-- address is stored, so the redaction path has one table to empty. The queue payload names a
-- recipient by reference (`contracts::EmailRecipient`), never by address.

-- ---------------------------------------------------------------------------------------
-- shop_contacts: the shop owner's address and name, as the Admin API reported them
-- ---------------------------------------------------------------------------------------
-- Written by `ctl` (it holds the Shopify token) from `shop { email name }` when it reads a shop
-- and on `shop/update`; read by the engine, which sends the mail. It is read at send time so the
-- uninstall export email can be queued after the token is gone: the address was stored while the
-- token still worked. `shop/redact` deletes the row.
create table shop_contacts (
  shop_id uuid primary key,
  tenant_id uuid not null references tenants (id),
  email text not null
    check (email = lower(email) and char_length(email) <= 254
           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  store_name text not null check (char_length(store_name) between 1 and 255),
  locale text check (char_length(locale) between 2 and 35),
  updated_at timestamptz not null default now(),
  foreign key (shop_id, tenant_id) references shopify_shops (id, tenant_id)
);
create index shop_contacts_tenant on shop_contacts (tenant_id);

alter table shop_contacts enable row level security;
create policy tenant_isolation on shop_contacts
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
-- Workers read it (the engine); only ctl's group writes it.
grant select on shop_contacts to rampsmith_app, rampsmith_worker;
grant insert, update, delete on shop_contacts to rampsmith_ctl;

-- ---------------------------------------------------------------------------------------
-- email_suppressions: addresses a tenant's mail must not go to
-- ---------------------------------------------------------------------------------------
-- The address is stored as a hash, so the list can be kept (an opt-out has to be honoured for as
-- long as the tenant exists) without keeping the address. `email_address_hash` is the one
-- definition of the hash; every writer and reader uses it.
create function email_address_hash(p_tenant uuid, p_address text) returns bytea
  language sql
  immutable
  parallel safe
as $$
  select sha256(convert_to(p_tenant::text || ':' || lower(btrim(p_address)), 'UTF8'))
$$;
grant execute on function email_address_hash(uuid, text) to rampsmith_app, rampsmith_worker;

create table email_suppressions (
  tenant_id uuid not null references tenants (id),
  address_hash bytea not null check (octet_length(address_hash) = 32),
  -- `unsubscribed` blocks notification and marketing mail (RFC 8058 one-click, ADR-191);
  -- `bounced`, `complained` and `manual` block every category.
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, address_hash)
);

alter table email_suppressions enable row level security;
create policy tenant_isolation on email_suppressions
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
-- The application records an unsubscribe; workers read the list and record bounces.
grant select, insert, update, delete on email_suppressions to rampsmith_app;
grant select, insert, update on email_suppressions to rampsmith_worker;

-- ---------------------------------------------------------------------------------------
-- email_deliveries: the sender's idempotency record (ADR-194, ADR-271)
-- ---------------------------------------------------------------------------------------
-- One row per message key. Amazon SES has no idempotency token, so the engine claims the key
-- before it calls SES and marks it sent after: a retried job finds `sent` and sends nothing.
-- Holds no address, subject or body.
create table email_deliveries (
  tenant_id uuid not null references tenants (id),
  message_key text not null check (message_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  template text not null check (template ~ '^[a-z_]{1,40}$'),
  state text not null check (state in ('sending', 'sent', 'suppressed', 'failed')),
  -- Sends tried, including the one in flight; the engine's deferral delay grows with it.
  tries int not null default 1 check (tries >= 1),
  message_id text check (char_length(message_id) <= 200),
  error_code text check (error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, message_key),
  check ((state = 'sent') = (message_id is not null))
);

alter table email_deliveries enable row level security;
create policy tenant_isolation on email_deliveries
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
grant select, insert, update on email_deliveries to rampsmith_worker;
grant select on email_deliveries to rampsmith_app;
