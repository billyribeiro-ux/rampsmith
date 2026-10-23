-- Which engines may run free scans (audit H1, ADR-280).
--
-- A free scan is anonymous: anyone on the internet chooses the site Chromium visits. The engine
-- therefore serves the `free_scan.run` queue only while its Chromium has its own sandbox on
-- (ADR-265). An engine that is serving it writes a row here every 15 seconds; the api accepts a
-- free scan only while a row is fresh, so a deployment whose engine had to start Chromium
-- without the sandbox answers "free scanner unavailable" instead of queueing work nobody runs.
--
-- Not a tenant table and not tenant data: a worker id and a time. The engine (a worker login)
-- writes its own row; the api reads.
create table free_scan_engines (
  worker_id text primary key check (char_length(worker_id) between 1 and 200),
  beat_at timestamptz not null default now()
);

grant select on free_scan_engines to rampsmith_app;
grant select, insert, update, delete on free_scan_engines to rampsmith_worker;

-- True while an engine with a sandboxed browser has said so in the last 45 seconds (three
-- missed beats). The age is the function's own, so a caller cannot choose it.
create function free_scan_engine_available()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (select 1 from free_scan_engines where beat_at > now() - interval '45 seconds');
$$;
revoke all on function free_scan_engine_available() from public;
grant execute on function free_scan_engine_available() to rampsmith_app, rampsmith_worker;

-- The sweep (ADR-267) also forgets engines that stopped beating an hour ago, so rows of
-- redeployed containers do not pile up.
create or replace function free_scans_sweep()
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
  delete from free_scan_engines where beat_at < now() - interval '1 hour';
  with gone as (delete from free_scans where expires_at < now() returning 1)
  select count(*) into swept from gone;
  return swept;
end
$$;
