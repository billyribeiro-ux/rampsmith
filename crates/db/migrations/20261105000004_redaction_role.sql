-- Redaction is the one thing that may delete AI call records (lane A audit L7, ADR-087).
--
-- `ai_calls` is insert-and-read-only for every service (ADR-037); migration 20261103000001
-- gave `rampsmith_worker` DELETE so `shop/redact` could empty it, which also let the engine,
-- whose login is a plain worker member, delete the cost record. DELETE goes away from the
-- worker; `ctl`'s login joins the new group `rampsmith_ctl` and deletes through a function
-- that can only touch the tenant the transaction is scoped to.

do $$
begin
  create role rampsmith_ctl nologin in role rampsmith_worker;
exception
  when duplicate_object or unique_violation then null;
end
$$;

revoke delete on ai_calls from rampsmith_worker;

create function redact_ai_calls() returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  scoped uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  removed bigint;
begin
  if scoped is null then
    raise exception 'redact_ai_calls needs a tenant-scoped transaction';
  end if;
  delete from ai_calls where tenant_id = scoped;
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke all on function redact_ai_calls() from public;
grant execute on function redact_ai_calls() to rampsmith_ctl;
