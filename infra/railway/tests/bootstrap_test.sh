#!/usr/bin/env bash
# Substitute test for the database part of a Railway environment (ADR-183, LAUNCH.md E):
# bootstrap.sql creates the logins on PostgreSQL 18, the migrator applies every migration, and
# the service logins get exactly their group's privileges with row-level security in force.
#
# Needs a superuser connection in PGHOST, PGPORT and PGUSER (PGPASSWORD if required), psql 15+,
# and `sqlx` (sqlx-cli) on PATH; without sqlx it applies the migration files with psql in order
# and says so. Roles are cluster-wide: run it against a disposable server.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
bootstrap="$root/infra/railway/bootstrap.sql"
migrations="$root/crates/db/migrations"
db="ws9_bootstrap_$RANDOM$RANDOM"
host=${PGHOST:-127.0.0.1}
port=${PGPORT:-5432}

fail() {
  echo "::error title=bootstrap test::$*"
  exit 1
}

hex() { openssl rand -hex 32; }

as_superuser() { psql -X -v ON_ERROR_STOP=1 -qtA -d "$db" "$@"; }

url() { echo "postgresql://$1:$2@$host:$port/$db"; }

as_login() {
  local login=$1 password=$2
  shift 2
  psql -X -v ON_ERROR_STOP=1 -qtA "$(url "$login" "$password")" "$@"
}

run_bootstrap() {
  psql -X -v ON_ERROR_STOP=1 -q -d "$db" -f "$bootstrap"
}

psql -X -v ON_ERROR_STOP=1 -q -d postgres -c "create database $db"
trap 'psql -X -q -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true' EXIT

export RAMPSMITH_DB_PASSWORD_MIGRATOR RAMPSMITH_DB_PASSWORD_API RAMPSMITH_DB_PASSWORD_CTL \
  RAMPSMITH_DB_PASSWORD_ENGINE
RAMPSMITH_DB_PASSWORD_MIGRATOR=$(hex)
RAMPSMITH_DB_PASSWORD_API=$(hex)
RAMPSMITH_DB_PASSWORD_CTL=$(hex)
RAMPSMITH_DB_PASSWORD_ENGINE=$(hex)

echo "1. bootstrap refuses a missing or malformed password"
if (unset RAMPSMITH_DB_PASSWORD_CTL; run_bootstrap) >/dev/null 2>&1; then
  fail "bootstrap ran without RAMPSMITH_DB_PASSWORD_CTL"
fi
if RAMPSMITH_DB_PASSWORD_API=short run_bootstrap >/dev/null 2>&1; then
  fail "bootstrap accepted a password that is not 64 hex digits"
fi
if RAMPSMITH_DB_PASSWORD_API=$RAMPSMITH_DB_PASSWORD_CTL run_bootstrap >/dev/null 2>&1; then
  fail "bootstrap accepted two logins with the same password"
fi

echo "2. bootstrap creates the logins"
run_bootstrap

echo "3. the migrator applies every migration"
migrator_url=$(url rampsmith_migrator "$RAMPSMITH_DB_PASSWORD_MIGRATOR")
if command -v sqlx >/dev/null 2>&1; then
  # Exactly what the api's pre-deploy step runs (infra/railway/railway.py).
  DATABASE_URL=$migrator_url sqlx migrate run --ignore-missing --source "$migrations"
  DATABASE_URL=$migrator_url sqlx migrate info --source "$migrations"
else
  echo "::notice title=bootstrap test::sqlx is not on PATH; applying the migrations with psql"
  for file in "$migrations"/*.sql; do
    psql -X -v ON_ERROR_STOP=1 -q -1 "$migrator_url" -f "$file"
  done
fi

echo "4. no login is privileged, and the migrator owns every table"
privileged=$(as_superuser -c "
  select string_agg(rolname, ',') from pg_roles
  where rolname in ('rampsmith_migrator', 'rampsmith_api', 'rampsmith_ctl', 'rampsmith_engine')
    and (rolsuper or rolbypassrls or rolreplication or rolcreatedb or not rolcanlogin)")
[ -z "$privileged" ] || fail "privileged or non-login roles: $privileged"
creators=$(as_superuser -c "
  select string_agg(rolname, ',') from pg_roles
  where rolname in ('rampsmith_api', 'rampsmith_ctl', 'rampsmith_engine') and rolcreaterole")
[ -z "$creators" ] || fail "service logins that can create roles: $creators"
foreign=$(as_superuser -c "
  select string_agg(c.relname || ':' || pg_get_userbyid(c.relowner), ',')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    and pg_get_userbyid(c.relowner) <> 'rampsmith_migrator'")
[ -z "$foreign" ] || fail "objects not owned by rampsmith_migrator: $foreign"
creators=$(as_superuser -c "
  select string_agg(r, ',') from unnest(array['rampsmith_api', 'rampsmith_ctl',
    'rampsmith_engine']) as r where has_schema_privilege(r, 'public', 'create')")
[ -z "$creators" ] || fail "service logins that can create objects: $creators"

echo "5. row-level security applies to the api login"
tenant=$(as_superuser -c "insert into tenants (id, kind) values (gen_random_uuid(), 'organization') returning id")
if out=$(as_login rampsmith_api "$RAMPSMITH_DB_PASSWORD_API" -c "select count(*) from tenants" 2>&1); then
  fail "rampsmith_api read tenants without a tenant context: $out"
fi
grep -q 'app.tenant_id' <<<"$out" || fail "unexpected error without a tenant: $out"
count_as() {
  as_login rampsmith_api "$RAMPSMITH_DB_PASSWORD_API" -c "
    begin;
    select set_config('app.tenant_id', '$1', true);
    select count(*) from tenants;
    commit;" | sed -n '2p'
}
[ "$(count_as "$tenant")" = 1 ] || fail "rampsmith_api cannot see its own tenant"
[ "$(count_as "$(as_superuser -c 'select gen_random_uuid()')")" = 0 ] ||
  fail "rampsmith_api saw another tenant's row"

echo "6. workers reach the job queue"
for login in ctl engine; do
  password_var="RAMPSMITH_DB_PASSWORD_${login^^}"
  as_login "rampsmith_$login" "${!password_var}" -c "select count(*) from jobs" >/dev/null ||
    fail "rampsmith_$login cannot read jobs"
done

echo "6b. only ctl's login may execute redact_ai_calls() (ADR-089)"
logins=$(as_superuser -c "
  select string_agg(rolname, ',' order by rolname) from pg_roles
  where rolcanlogin and rolname like 'rampsmith%'")
[ "$logins" = "rampsmith_api,rampsmith_ctl,rampsmith_engine,rampsmith_migrator" ] ||
  fail "unexpected rampsmith login roles (a second login for ctl?): $logins"
for login in ctl api engine; do
  want=f
  [ "$login" = ctl ] && want=t
  got=$(as_superuser -c "select has_function_privilege('rampsmith_$login', 'public.redact_ai_calls()', 'execute')")
  [ "$got" = "$want" ] || fail "rampsmith_$login: has_function_privilege on redact_ai_calls() is $got, expected $want"
done
[ "$(as_superuser -c "select pg_has_role('rampsmith_ctl', 'rampsmith_redactor', 'member')")" = t ] ||
  fail "rampsmith_ctl is not a member of rampsmith_redactor"
[ "$(as_superuser -c "select pg_has_role('rampsmith_engine', 'rampsmith_redactor', 'member')
  or pg_has_role('rampsmith_api', 'rampsmith_redactor', 'member')")" = f ] ||
  fail "the engine or the api login is a member of rampsmith_redactor"
as_login rampsmith_ctl "$RAMPSMITH_DB_PASSWORD_CTL" -c "
  begin;
  select set_config('app.tenant_id', '$tenant', true);
  select redact_ai_calls();
  commit;" >/dev/null || fail "rampsmith_ctl cannot run redact_ai_calls()"
if out=$(as_login rampsmith_engine "$RAMPSMITH_DB_PASSWORD_ENGINE" -c "
  begin;
  select set_config('app.tenant_id', '$tenant', true);
  select redact_ai_calls();
  commit;" 2>&1); then
  fail "rampsmith_engine ran redact_ai_calls()"
fi
grep -q 'permission denied' <<<"$out" || fail "unexpected error for the engine: $out"

echo "7. running bootstrap again rotates the passwords"
old_api=$RAMPSMITH_DB_PASSWORD_API
RAMPSMITH_DB_PASSWORD_API=$(hex)
run_bootstrap
if as_login rampsmith_api "$old_api" -c "select 1" >/dev/null 2>&1; then
  fail "the old api password still works after a rotation"
fi
as_login rampsmith_api "$RAMPSMITH_DB_PASSWORD_API" -c "select 1" >/dev/null ||
  fail "the new api password does not work"

echo "bootstrap test: PASS"
