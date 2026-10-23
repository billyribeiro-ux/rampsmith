-- The webhook backstop (lane A audit M2). The listener answers 200 once the event and its
-- job are stored, so Shopify never retries a stored event; if `webhook.process` dies or is
-- lost, only this sweep brings the event back. It runs for every tenant, so it is a security
-- definer with fixed ages (a worker login cannot use it to touch anything else).
--
-- - an event unprocessed for 30 minutes with no live (ready or running) job gets a new job,
--   at most one per hour (the idempotency key carries the hour), for 14 days after arrival;
-- - `stuck_24h` counts events unprocessed for 24 hours or more, which ctl reports as an alert.
create function webhook_events_sweep()
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
     where e.processed_at is null
       and e.received_at < now() - interval '30 minutes'
       and e.received_at > now() - interval '14 days'
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
     where e.processed_at is null;
end
$$;

revoke all on function webhook_events_sweep() from public;
grant execute on function webhook_events_sweep() to rampsmith_worker;
