-- What the audit log recorded in a time window (ADR-179). Break-glass: it reads across tenants.
--
--   railway connect postgres --ssh          (as the database superuser, in a private terminal)
--   \set since '2026-10-19 10:00+00'
--   \set until '2026-10-19 14:00+00'        (optional; default is now)
--   \i docs/runbooks/sql/audit-window.sql
--
-- It answers "what did the system, a user or an operator do in this window, and across how many
-- tenants" for an incident's scope. It prints counts and, for operator actions only, the time,
-- tenant id, operator name and action. It never prints the `data` column: that column can hold
-- whatever the code that wrote the row put there, and an incident ticket must not collect it.
--
-- `audit_log` is append-only (a trigger rejects update and delete, even for the owner), so what is
-- here was not edited afterwards. It records only what the code chose to audit: an empty result is
-- not proof that nothing happened, and the logs are the other half of the evidence.
--
-- Like master-key-usage.sql it refuses any role that row-level security applies to.

\set ON_ERROR_STOP on

\if :{?since}
\else
  \warn 'refused: pass the start of the window as the psql variable since, for example -v since=2026-10-19T10:00:00Z'
  do $$ begin raise exception 'audit-window.sql needs the psql variable since=<timestamp>'; end $$;
\endif

select (rolsuper or rolbypassrls) as sees_every_tenant
  from pg_roles
 where rolname = current_user
\gset

\if :sees_every_tenant
\else
  \warn 'refused: this query must run as the database superuser (break-glass, PLAN section 18)'
  do $$ begin raise exception 'audit-window.sql needs a role that bypasses row-level security'; end $$;
\endif

\if :{?until}
  select :'until'::timestamptz as window_end
  \gset
\else
  select now() as window_end
  \gset
\endif

\echo 'audit rows by action and actor kind in the window'
select action, actor_kind, count(*) as rows, count(distinct tenant_id) as tenants
  from audit_log
 where at >= :'since'::timestamptz
   and at < :'window_end'::timestamptz
 group by action, actor_kind
 order by rows desc, action, actor_kind;

\echo 'tenants with any audit row in the window'
select count(distinct tenant_id) as tenants
  from audit_log
 where at >= :'since'::timestamptz
   and at < :'window_end'::timestamptz;

\echo 'operator actions in the window (every one is a person using break-glass or rsctl)'
select at, tenant_id, actor_id as operator, action
  from audit_log
 where actor_kind = 'operator'
   and at >= :'since'::timestamptz
   and at < :'window_end'::timestamptz
 order by at;
