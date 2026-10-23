-- Per-category opt-outs (ADR-274, ADR-275): what a recipient switched off with the unsubscribe
-- link of one message category, the preferences link, or the email section of the App Home
-- settings. Expand only: one new table.
--
-- `email_suppressions` (ADR-273) stays the list of addresses that cannot be mailed at all
-- (bounced, complained, manual); a row here switches off one *category* for one address, which is
-- what RFC 8058 one-click and the preferences screen need, and which a person can turn back on.
-- The address is a hash (`email_address_hash`), never the address, so the list can be kept for as
-- long as the tenant exists (an opt-out must be honoured: CAN-SPAM, CASL, GDPR Art. 21) without
-- keeping the address, and `shop/redact` leaves it alone.
create table email_opt_outs (
  tenant_id uuid not null references tenants (id),
  address_hash bytea not null check (octet_length(address_hash) = 32),
  -- `security` and `transactional` mail cannot be switched off (ADR-191, ADR-275).
  category text not null check (category in ('notification', 'marketing')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, address_hash, category)
);

alter table email_opt_outs enable row level security;
create policy tenant_isolation on email_opt_outs
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
-- The application records a choice and takes it back; workers (the engine, which sends) read it.
grant select, insert, delete on email_opt_outs to rampsmith_app;
grant select on email_opt_outs to rampsmith_worker;
