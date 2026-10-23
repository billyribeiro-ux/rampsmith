-- Email data: who may read it, and how long it lives (audit L5, L6; ADR-277, PLAN §19).
--
-- L6. The owner's address is read by the engine's mailer (a worker) and written by ctl; nothing
-- the application role serves reads it, so the api login loses the SELECT migration
-- 20261106000001 gave it. A compromised api can no longer list the shop owners' addresses.
revoke select on shop_contacts from rampsmith_app;

-- The App Home email switch needs to know *which* address the mail goes to, to read that
-- address's opt-outs, and nothing more. The hash comes from a function that runs with the
-- table owner's rights, answers only for the session's tenant, and returns no address. A
-- compromised api can ask for the hash of its own tenant's shop, as it could before, but cannot
-- list contacts.
create function email_notification_hash(p_shop uuid)
  returns bytea
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select email_address_hash(
           c.tenant_id,
           coalesce(nullif(btrim(st.settings ->> 'notification_email'), ''), c.email))
    from shop_contacts c
    join shopify_shops sh on sh.id = c.shop_id and sh.tenant_id = c.tenant_id
    join sites st on st.id = sh.site_id and st.tenant_id = sh.tenant_id
   where c.tenant_id = (select app_current_tenant()) and c.shop_id = p_shop
$$;

revoke all on function email_notification_hash(uuid) from public;
grant execute on function email_notification_hash(uuid) to rampsmith_app, rampsmith_worker;

-- L5. `shop/redact` deletes the shop's delivery records with the rest of its data. The redaction
-- group already holds the other deletes (migration 20261107000001); the ledger gets this one.
grant delete on email_deliveries to rampsmith_redactor;

-- L5. Two clocks for data that would otherwise outlive its purpose when `shop/redact` never
-- arrives. Ages are fixed here, not parameters, so a worker login cannot use the function to
-- delete anything younger. It is a security definer because it runs for every tenant.
--
-- - `shop_contacts`: 30 days after the shop was uninstalled. Shopify sends `shop/redact` 48 hours
--   after an uninstall; a month is the margin for a redelivery, and the export email has gone by
--   then (it is sent within minutes and its retries stop after about half a day).
-- - `email_deliveries`: 90 days after the last change. A message key only has to stay claimed
--   while a retry or a replayed webhook could still name it.
--
-- `email_suppressions` and `email_opt_outs` are kept for as long as the tenant exists: an opt-out
-- must be honoured on reinstall. They hold SHA-256 of the tenant id and the address, never the
-- address. Anyone with the database can test a guessed address against it, so the hash is
-- pseudonymous data, not anonymous (PLAN §19).
create function email_records_sweep()
  returns bigint
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  with contacts as (
    delete from shop_contacts c
     using shopify_shops sh
     where sh.id = c.shop_id and sh.tenant_id = c.tenant_id
       and sh.status <> 'installed'
       and coalesce(sh.uninstalled_at, c.updated_at) < now() - interval '30 days'
    returning 1
  ), deliveries as (
    delete from email_deliveries
     where updated_at < now() - interval '90 days' and state <> 'sending'
    returning 1
  )
  select (select count(*) from contacts) + (select count(*) from deliveries)
$$;

revoke all on function email_records_sweep() from public;
grant execute on function email_records_sweep() to rampsmith_worker;
