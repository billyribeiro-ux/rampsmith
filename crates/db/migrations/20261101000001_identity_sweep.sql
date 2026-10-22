-- Sweeping expired sign-in state (audit M6, ADR-042).
--
-- Passkey ceremonies live five minutes and sessions at most thirty days, but nothing deleted
-- them once they expired. The `ctl` leader now does, every few minutes. `ctl` runs as
-- `rampsmith_worker`, which has no grants on the identity tables (migration 6) and keeps
-- none: this function is the only thing it may do there, and the api may not call it. It
-- takes no argument and deletes only rows that the database's own clock says are expired, so
-- a caller learns nothing and can destroy nothing that was not already dead. Security
-- definer: it runs as the schema owner, like `app_shop_by_domain` (migration 5).
create function identity_sweep()
  returns bigint
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  sessions bigint;
  ceremonies bigint;
begin
  delete from web_sessions
   where idle_expires_at <= now() or absolute_expires_at <= now();
  get diagnostics sessions = row_count;
  delete from webauthn_ceremonies
   where expires_at <= now();
  get diagnostics ceremonies = row_count;
  return sessions + ceremonies;
end
$$;

revoke all on function identity_sweep() from public;
grant execute on function identity_sweep() to rampsmith_worker;
