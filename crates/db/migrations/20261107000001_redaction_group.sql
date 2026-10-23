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
--   else (since the email sender, the writes to `shop_contacts` too). bootstrap.sql creates it and makes ctl's login a member; the engine's and the api's
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

-- Migration 20261106000001 granted the writes to `shop_contacts` to the same ambiguous name.
-- Only ctl writes the owner's address (and `shop/redact` deletes it), so the group that holds
-- ctl's extra privileges holds them too; the worker group keeps `select` for the engine.
grant insert, update, delete on shop_contacts to rampsmith_redactor;
revoke insert, update, delete on shop_contacts from rampsmith_ctl;
