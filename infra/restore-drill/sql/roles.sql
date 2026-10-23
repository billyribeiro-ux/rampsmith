-- The roles a Rampsmith database needs before any migration or restore (ADR-006, ADR-175).
--
-- In production `infra/railway/bootstrap.sql` (ADR-183 on the deploy stream) creates them once per
-- environment. This file is its fixture twin for the restore drill: the same group roles, the
-- same migration role owning schema public, and one login per kind of service. The backup
-- role is separate (infra/backup/backup-role.sql). `pg_dump` never dumps roles, so a database
-- restored into a fresh server is useless until these exist; the restore runbook runs
-- bootstrap.sql first for exactly that reason.
--
-- Run as the database superuser, connected to the database being prepared. Safe to repeat.

\set ON_ERROR_STOP on

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

do $$
begin
  create role rampsmith_redactor nologin;
exception
  when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  create role rampsmith_migrator login createrole nosuperuser nocreatedb noreplication nobypassrls;
exception
  when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  create role rampsmith_api login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
    in role rampsmith_app;
exception
  when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  create role rampsmith_ctl login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
    in role rampsmith_worker;
exception
  when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  create role rampsmith_engine login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
    in role rampsmith_worker;
exception
  when duplicate_object or unique_violation then null;
end
$$;

-- ctl's login redacts a shop's AI call records through redact_ai_calls() (ADR-089).
grant rampsmith_redactor to rampsmith_ctl;

select format('grant connect, create, temporary on database %I to rampsmith_migrator',
              current_database())
\gexec
select format('grant connect on database %I to rampsmith_api, rampsmith_ctl, rampsmith_engine',
              current_database())
\gexec
alter schema public owner to rampsmith_migrator;
