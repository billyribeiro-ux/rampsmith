-- Database logins for one Railway environment (ADR-183). Run once per environment, before the
-- first deploy, as the database superuser that Railway's PostgreSQL template creates:
--
--   export RAMPSMITH_DB_PASSWORD_MIGRATOR=...  RAMPSMITH_DB_PASSWORD_API=...
--   export RAMPSMITH_DB_PASSWORD_CTL=...       RAMPSMITH_DB_PASSWORD_ENGINE=...
--   railway connect postgres --ssh        (psql 15 or newer, over SSH: no public TCP proxy)
--   \i infra/railway/bootstrap.sql
--
-- Each password is the value of the Railway shared variable of the same name, generated with
-- `openssl rand -hex 32` (64 hex digits, so it needs no escaping inside a connection URL).
-- Running it again is safe: it re-applies the attributes and sets the passwords again, which is
-- how they are rotated.
--
-- The roles:
--   rampsmith_migrator  runs `sqlx migrate run` in the api's pre-deploy step and owns every
--                       object it creates. Not a superuser, no BYPASSRLS. CREATEROLE because
--                       migrations create the group roles.
--   rampsmith_api       login for `api`, member of rampsmith_app.
--   rampsmith_ctl       login for `ctl`, member of rampsmith_worker.
--   rampsmith_engine    login for `engine`, member of rampsmith_worker.
-- None of the service logins is a superuser, owns a table, or has BYPASSRLS, so every
-- row-level security policy applies to them (ADR-006, crates/db/migrations).

\set ON_ERROR_STOP on
\set QUIET on
\set ECHO none
\set ECHO_HIDDEN off

-- Keep the passwords out of the server log, whatever its settings.
set log_statement = 'none';
set log_min_error_statement = 'panic';
set log_min_duration_statement = -1;
set client_min_messages = warning;

\getenv migrator_password RAMPSMITH_DB_PASSWORD_MIGRATOR
\getenv api_password RAMPSMITH_DB_PASSWORD_API
\getenv ctl_password RAMPSMITH_DB_PASSWORD_CTL
\getenv engine_password RAMPSMITH_DB_PASSWORD_ENGINE

\if :{?migrator_password}
\else
  \warn 'RAMPSMITH_DB_PASSWORD_MIGRATOR is not set'
  select 1 / 0 as bootstrap_refused;
\endif
\if :{?api_password}
\else
  \warn 'RAMPSMITH_DB_PASSWORD_API is not set'
  select 1 / 0 as bootstrap_refused;
\endif
\if :{?ctl_password}
\else
  \warn 'RAMPSMITH_DB_PASSWORD_CTL is not set'
  select 1 / 0 as bootstrap_refused;
\endif
\if :{?engine_password}
\else
  \warn 'RAMPSMITH_DB_PASSWORD_ENGINE is not set'
  select 1 / 0 as bootstrap_refused;
\endif

select
  :'migrator_password' ~ '^[0-9a-f]{64}$'
  and :'api_password' ~ '^[0-9a-f]{64}$'
  and :'ctl_password' ~ '^[0-9a-f]{64}$'
  and :'engine_password' ~ '^[0-9a-f]{64}$'
  and count(distinct p) = 4 as passwords_ok
from unnest(array[:'migrator_password', :'api_password', :'ctl_password', :'engine_password']) as p
\gset
\if :passwords_ok
\else
  \warn 'Each password must be 64 lowercase hex digits (openssl rand -hex 32), all different.'
  select 1 / 0 as bootstrap_refused;
\endif

select rolsuper as is_superuser from pg_roles where rolname = current_user
\gset
\if :is_superuser
\else
  \warn 'Run this as the database superuser (railway connect postgres).'
  select 1 / 0 as bootstrap_refused;
\endif

begin;

-- Group roles. The first migration creates them too and tolerates them existing.
do $$
begin
  create role rampsmith_app nologin;
exception
  when duplicate_object or unique_violation then null;
end
$$;
do $$
begin
  create role rampsmith_worker nologin;
exception
  when duplicate_object or unique_violation then null;
end
$$;

-- Logins: create the missing ones, then (re)apply attributes and passwords to all of them.
select format('create role %I', name)
from (values ('rampsmith_migrator'), ('rampsmith_api'), ('rampsmith_ctl'), ('rampsmith_engine'))
  as wanted(name)
where not exists (select from pg_roles where rolname = wanted.name)
\gexec

select format(
  'alter role %I with login nosuperuser nocreatedb createrole noreplication nobypassrls '
  'inherit password %L',
  'rampsmith_migrator', :'migrator_password'
)
\gexec
select format(
  'alter role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls '
  'inherit password %L',
  login, password
)
from (values
  ('rampsmith_api', :'api_password'),
  ('rampsmith_ctl', :'ctl_password'),
  ('rampsmith_engine', :'engine_password')
) as logins(login, password)
\gexec

grant rampsmith_app to rampsmith_api;
grant rampsmith_worker to rampsmith_ctl, rampsmith_engine;

-- The migrator owns the schema, so it can create objects and grant on them.
select format('grant connect, create, temporary on database %I to rampsmith_migrator',
              current_database())
\gexec
alter schema public owner to rampsmith_migrator;

commit;

\unset migrator_password
\unset api_password
\unset ctl_password
\unset engine_password
\echo 'bootstrap: rampsmith_migrator, rampsmith_api, rampsmith_ctl and rampsmith_engine are ready'
