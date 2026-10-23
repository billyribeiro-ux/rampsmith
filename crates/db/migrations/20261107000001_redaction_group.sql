-- The redaction privilege moves to a group of its own (re-audit M-3, ADR-089).
--
-- Migration 20261105000004 granted `redact_ai_calls()` to a role it called `rampsmith_ctl`.
-- In production that name is already ctl's LOGIN (infra/railway/bootstrap.sql), so the
-- `create role` there hit duplicate_object and was swallowed, and the grant landed on the
-- login by a coincidence of names; the tests used a separate NOLOGIN group of the same name,
-- and LAUNCH.md told the founder to create a second login `IN ROLE rampsmith_ctl`, which would
-- have been a second, over-privileged login. The name stops carrying two meanings:
--
-- - `rampsmith_redactor` is a NOLOGIN group that may execute the function and can do nothing
--   else. bootstrap.sql creates it and makes ctl's login a member; the engine's and the api's
--   logins are not (the startup guards of `ctl`, the api and the engine check it);
-- - the function privilege is taken from the role called `rampsmith_ctl`, whichever it is.
--
-- This file may run before or after bootstrap.sql created the group, so creation tolerates it
-- existing, exactly as the group roles of the first migration do.

do $$
begin
  create role rampsmith_redactor nologin;
exception
  when duplicate_object or unique_violation then null;
end
$$;

grant execute on function redact_ai_calls() to rampsmith_redactor;
revoke execute on function redact_ai_calls() from rampsmith_ctl;
