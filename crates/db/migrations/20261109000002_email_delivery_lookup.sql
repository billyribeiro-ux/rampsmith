-- Bounces and complaints find their tenant by the message id SES gave (ADR-278).
--
-- An SES event reaches the api with no session and no tenant: it names the SES message id
-- (`mail.messageId`), which the mailer stored in `email_deliveries.message_id` when SES accepted
-- the message. This function turns that id into the tenant that sent it, so the api can then
-- open an ordinary tenant transaction and write the suppression there.
--
-- It is a security definer because the application role cannot read the table without a tenant,
-- and it returns the tenant id only: no template, no key, no state. An SES message id is long
-- and unguessable, so the function is not a way to enumerate tenants.
create index email_deliveries_message_id
  on email_deliveries (message_id)
  where message_id is not null;

create function email_delivery_tenant(p_message_id text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select tenant_id from email_deliveries where message_id = p_message_id limit 1
$$;

revoke all on function email_delivery_tenant(text) from public;
grant execute on function email_delivery_tenant(text) to rampsmith_app;
