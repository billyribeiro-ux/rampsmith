-- The login the nightly backup uses (ADR-171). Run once per environment as a superuser:
--
--   BACKUP_DB_PASSWORD='...' psql -X -v ON_ERROR_STOP=1 -d <database> -f backup-role.sql
--
-- What it needs and why:
--   - SELECT on every table, sequence and schema: the built-in group role pg_read_all_data.
--   - BYPASSRLS. pg_dump sets row_security = off, and PostgreSQL then raises an error for a role
--     that cannot bypass row-level security instead of dumping a filtered copy. With the
--     attribute the dump holds every tenant's rows; without it, the nightly job fails loudly.
--   - Nothing else: not a superuser, no CREATE, no write access, and the session is read-only by
--     default. The password is stored hashed (scram-sha-256) and never reaches the server log.
-- The login owns nothing, so the restore never needs it: objects land on rampsmith_migrator.

\set ON_ERROR_STOP on

-- A superuser may stop statements from being logged, so the CREATE ROLE text below (which
-- carries the password) does not reach the server log.
set log_statement = 'none';
set password_encryption = 'scram-sha-256';

\getenv backup_password BACKUP_DB_PASSWORD
\if :{?backup_password}
\else
  \echo 'BACKUP_DB_PASSWORD is not set'
  \quit
\endif

select exists (select 1 from pg_roles where rolname = 'rampsmith_backup') as role_exists \gset
\if :role_exists
  alter role rampsmith_backup login nosuperuser nocreatedb nocreaterole noreplication bypassrls
    password :'backup_password';
\else
  create role rampsmith_backup login nosuperuser nocreatedb nocreaterole noreplication bypassrls
    password :'backup_password';
\endif

alter role rampsmith_backup set default_transaction_read_only = on;
grant pg_read_all_data to rampsmith_backup;
select format('grant connect on database %I to rampsmith_backup', current_database()) \gexec
