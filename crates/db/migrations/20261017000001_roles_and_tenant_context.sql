-- Roles and the tenant context used by every row-level security policy (PLAN §9, ADR-006).
--
-- Whoever runs migrations owns the tables. The application never connects as the owner:
-- deploys create LOGIN users that are members of these NOLOGIN group roles. Neither group
-- role is a superuser, owns a table, or has BYPASSRLS, so every policy applies to them.
--
--   rampsmith_app     the api service, acting for one tenant per transaction
--   rampsmith_worker  ctl and engine, which also set the tenant per job
--
-- Roles are cluster-wide, so creation tolerates a concurrent or earlier creation.

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

grant usage on schema public to rampsmith_app, rampsmith_worker;

-- The tenant of the current transaction, set by TenantTx with
-- `set_config('app.tenant_id', <uuid>, true)`. When it was never set, or a pooled
-- connection carries the empty value left behind by an earlier transaction, this raises an
-- error: a query that forgot its tenant fails loudly instead of returning someone's rows.
create function app_current_tenant() returns uuid
  language sql
  stable
  parallel safe
as $$
  select current_setting('app.tenant_id')::uuid
$$;

revoke all on function app_current_tenant() from public;
grant execute on function app_current_tenant() to rampsmith_app, rampsmith_worker;
