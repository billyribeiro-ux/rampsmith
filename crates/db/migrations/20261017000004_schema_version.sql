-- The newest applied migration, for the api's readiness check (PLAN §22: `/readyz` checks
-- the database and the migration version). Security definer, because application roles
-- are not granted the migrations table itself. Null when migrations were applied by a tool
-- that keeps no `_sqlx_migrations` table, such as the TypeScript test harness.
create function app_schema_version() returns bigint
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  newest bigint;
begin
  if to_regclass('public._sqlx_migrations') is null then
    return null;
  end if;
  execute 'select max(version) from _sqlx_migrations where success' into newest;
  return newest;
end
$$;

revoke all on function app_schema_version() from public;
grant execute on function app_schema_version() to rampsmith_app, rampsmith_worker;
