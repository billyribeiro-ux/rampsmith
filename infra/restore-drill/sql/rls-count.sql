-- Row visibility for one tenant, table by table (ADR-175), the isolation approach of the suite in
-- crates/db/tests/tenancy.rs: connect as a non-owner login, set `app.tenant_id` for the
-- transaction exactly like a TenantTx, and count.
--
--   psql -v tenant=<uuid> -U <role> -f rls-count.sql
--
-- For every table that has a `tenant_id` column (and `tenants`, keyed by `id`) it prints
--   rls <TAB> <table> <TAB> <rows of the tenant> <TAB> <rows of any other tenant>
-- Run as the owner it shows what exists; run as an application login it shows what row-level
-- security lets through. verify.sh requires the two "own" columns to be equal and the
-- application login's "other" column to be zero.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off

begin;
select set_config('app.tenant_id', :'tenant', true) as tenant_scope \gset

select format($q$
  select 'rls', %1$L,
         count(*) filter (where %2$I = %3$L::uuid)::text,
         count(*) filter (where %2$I <> %3$L::uuid)::text
    from %1$s$q$,
  format('%I.%I', n.nspname, c.relname),
  case when c.relname = 'tenants' then 'id' else 'tenant_id' end,
  :'tenant')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  and (c.relname = 'tenants'
       or exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))
order by 1
\gexec

rollback;
