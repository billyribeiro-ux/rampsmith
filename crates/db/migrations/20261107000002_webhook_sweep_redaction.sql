-- The webhook backstop after a shop is redacted, and for the compliance topics (re-audit M-1,
-- M-2, ADR-269). `create or replace` keeps the function's grants; its signature is unchanged.
--
-- - Events of a redacted shop whose body redaction cleared can never be processed (the worker
--   would find nothing to read). They are not re-queued and do not count towards `stuck_24h`
--   or `oldest_seconds`, which page a person; `redact::shop` now closes such events itself, and
--   the statement below closes the ones an earlier build left behind.
-- - `customers/data_request`, `customers/redact` and `shop/redact` keep being re-queued for 45
--   days instead of 14. PLAN §19 gives 30 days to act on them; a store that Shopify answers
--   with 402 or 423 for weeks, or a deleted store, must not use up the window before a person
--   has confirmed the uninstall and run `rsctl shops redact` (docs/runbooks/webhook-backlog.md).

update webhook_events e
   set processed_at = now()
  from shopify_shops s
 where s.tenant_id = e.tenant_id
   and s.id = e.shop_id
   and s.status = 'redacted'
   and e.processed_at is null
   and e.body is null;

create or replace function webhook_events_sweep()
  returns table (requeued bigint, stuck_24h bigint, oldest_seconds bigint)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  requeued_count bigint;
begin
  with stale as (
    select e.id, e.tenant_id
      from webhook_events e
      join shopify_shops s on s.tenant_id = e.tenant_id and s.id = e.shop_id
     where e.processed_at is null
       and not (e.body is null and s.status = 'redacted')
       and e.received_at < now() - interval '30 minutes'
       and e.received_at > now() - case
             when e.topic in ('customers/data_request', 'customers/redact', 'shop/redact')
               then interval '45 days'
             else interval '14 days'
           end
       and not exists (
         select 1 from jobs j
          where j.queue = 'webhook.process'
            and j.state in ('ready', 'running')
            and j.payload ->> 'event_id' = e.id::text
       )
  ), queued as (
    insert into jobs (id, queue, payload_schema, payload, tenant_id, state, max_attempts,
                      idempotency_key)
    select uuidv7(), 'webhook.process', 'webhook.process@1',
           jsonb_build_object('event_id', s.id), s.tenant_id, 'ready', 96,
           'webhook.process:' || s.id || ':sweep:' || to_char(now(), 'YYYYMMDDHH24')
      from stale s
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select count(*) into requeued_count from queued;
  if requeued_count > 0 then
    perform pg_notify('jobs', 'webhook.process');
  end if;
  return query
    select requeued_count,
           count(*) filter (where e.received_at < now() - interval '24 hours'),
           coalesce(max(extract(epoch from now() - e.received_at))::bigint, 0)
      from webhook_events e
      join shopify_shops s on s.tenant_id = e.tenant_id and s.id = e.shop_id
     where e.processed_at is null
       and not (e.body is null and s.status = 'redacted');
end
$$;
