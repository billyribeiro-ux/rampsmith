-- The free scanner's anonymous scans (PLAN §16, ADR-265).
--
-- Not a tenant table: no merchant owns a free scan, and nothing in it is tenant data. It holds
-- a public domain, a keyed hash of the visitor's address (never the address), the status of the
-- scan and its result. The row is the visitor's quota ledger and the 24-hour result cache, and
-- it is deleted when it expires (`free_scans_sweep`). The api inserts and reads; the engine
-- (a worker login) updates the scan it runs; nothing else touches it.
create table free_scans (
  id uuid primary key,
  domain text not null
    check (char_length(domain) <= 253
           and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  origin text not null check (char_length(origin) <= 300 and origin ~ '^https?://[^/@[:space:]]+/$'),
  -- HMAC-SHA256 of the visitor's address (the /64 for IPv6) under a key derived from the
  -- service token. Counting needs equality only; the address cannot be recovered.
  ip_hash bytea not null check (octet_length(ip_hash) = 32),
  status text not null check (status in ('queued', 'running', 'complete', 'refused', 'failed')),
  refusal text check (refusal in ('robots', 'bot-challenge', 'unreachable')),
  result jsonb check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  check ((status = 'refused') = (refusal is not null)),
  check ((status = 'complete') = (result is not null)),
  check ((status in ('complete', 'refused', 'failed')) = (finished_at is not null))
);
create index free_scans_ip on free_scans (ip_hash, created_at);
create index free_scans_domain on free_scans (domain, created_at);
create index free_scans_expiry on free_scans (expires_at);

grant select, insert on free_scans to rampsmith_app;
grant select, update on free_scans to rampsmith_worker;

-- The api enqueues the run for no tenant, which the job table's policy for the application role
-- does not allow, and should not: this function is the one tenantless job it may create, for one
-- queue, naming an existing free scan.
create function free_scan_enqueue(p_free_scan uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from free_scans where id = p_free_scan and status = 'queued') then
    raise exception 'no such queued free scan' using errcode = '23503';
  end if;
  insert into jobs (id, queue, payload_schema, payload, state, max_attempts, idempotency_key)
  values (gen_random_uuid(), 'free_scan.run', 'free_scan.run@1',
          jsonb_build_object('free_scan_id', p_free_scan), 'ready', 3,
          'free_scan.run:' || p_free_scan::text)
  on conflict (idempotency_key) do nothing;
  perform pg_notify('jobs', 'free_scan.run');
end
$$;
revoke all on function free_scan_enqueue(uuid) from public;
grant execute on function free_scan_enqueue(uuid) to rampsmith_app;

-- Ends scans the engine never finished (down, or a job that died) so they stop holding a
-- domain and a place under the in-flight ceiling, then deletes expired scans: their results,
-- their counts and the hashed addresses. The ages are the table's own, so a caller cannot
-- choose what to change. Returns how many scans it deleted. Run by `ctl`'s leader.
create function free_scans_sweep()
  returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  swept bigint;
begin
  update free_scans set status = 'failed', finished_at = now()
   where status in ('queued', 'running') and created_at < now() - interval '10 minutes';
  with gone as (delete from free_scans where expires_at < now() returning 1)
  select count(*) into swept from gone;
  return swept;
end
$$;
revoke all on function free_scans_sweep() from public;
grant execute on function free_scans_sweep() to rampsmith_worker;
