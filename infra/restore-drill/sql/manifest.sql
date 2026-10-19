-- The restore manifest (ADR-175): what a database must still hold after a restore.
--
--   psql -X -At -F '<TAB>' -f manifest.sql <database> | LC_ALL=C sort > manifest.tsv
--
-- Every line is tab-separated and ends in its value; the fields before the value are its key.
-- The manifest is written at dump time and read again after the restore, by the same file, so
-- both sides are produced by the same queries. It records, for the schema `public`:
--   - the migration version, and the number of migrations applied;
--   - per table: row count, an order-independent content checksum, owner, whether row-level
--     security is on, and a digest of its privileges;
--   - per object: every policy, constraint, index, trigger, function and partition, with a digest
--     of its definition;
--   - the attributes and memberships of the roles a restore target must have.
-- It reads one snapshot, so the counts and checksums agree with each other. Run as a role that
-- bypasses row-level security (a superuser, the owner or a BYPASSRLS role), or the counts are
-- the role's own view.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off

set timezone = 'UTC';
set datestyle = 'ISO, MDY';
set intervalstyle = 'postgres';
set extra_float_digits = 3;
set bytea_output = 'hex';
-- Without `public` on the path, every name below is schema-qualified.
set search_path = pg_catalog;

begin isolation level repeatable read read only;

select 'meta', 'format', 'rampsmith-restore-manifest/1';
select 'info', 'server_version', current_setting('server_version');
select 'meta', 'schema_version',
       coalesce((select max(version)::text from public._sqlx_migrations where success), 'none');
select 'meta', 'migrations', count(*)::text from public._sqlx_migrations;
select 'meta', 'database_encoding', pg_encoding_to_char(encoding) from pg_database
 where datname = current_database();

-- Tables: rows and content checksum (the sum of a 64-bit digest of each row's text, so the
-- order of rows does not matter), counted in this snapshot.
select format($q$
  select 'table', %1$L, 'rows', count(*)::text from %1$s
  union all
  select 'table', %1$L, 'checksum',
         coalesce(sum(('x' || substr(md5(t::text), 1, 16))::bit(64)::bigint::numeric), 0)::text
    from %1$s as t$q$,
  c.oid::regclass::text)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
order by c.oid::regclass::text
\gexec

-- Tables: owner, row-level security and privileges.
select 'table', c.oid::regclass::text, 'owner', pg_get_userbyid(c.relowner)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition;

select 'table', c.oid::regclass::text, 'rls',
       case when c.relrowsecurity then 'on' else 'off' end
       || case when c.relforcerowsecurity then '+forced' else '' end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition;

select 'table', c.oid::regclass::text, 'privileges',
       md5(coalesce((select string_agg(a::text, ',' order by a::text)
                       from unnest(c.relacl) as a), ''))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition;

-- Objects: a digest of each definition.
select 'object', 'partition', c.oid::regclass::text, p.oid::regclass::text
from pg_class c
join pg_inherits i on i.inhrelid = c.oid
join pg_class p on p.oid = i.inhparent
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p');

select 'object', 'policy', pol.polrelid::regclass::text || '.' || pol.polname,
       md5(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|'
           || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') || '|'
           || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
           || coalesce((select string_agg(case when r = 0 then 'public' else pg_get_userbyid(r) end,
                                          ',' order by case when r = 0 then 'public'
                                                            else pg_get_userbyid(r) end)
                          from unnest(pol.polroles) as r), ''))
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public';

select 'object', 'constraint', con.conrelid::regclass::text || '.' || con.conname,
       md5(pg_get_constraintdef(con.oid))
from pg_constraint con
join pg_namespace n on n.oid = con.connamespace
where n.nspname = 'public' and con.conrelid <> 0;

select 'object', 'index', i.indexrelid::regclass::text, md5(pg_get_indexdef(i.indexrelid))
from pg_index i
join pg_class c on c.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public';

select 'object', 'trigger', t.tgrelid::regclass::text || '.' || t.tgname,
       md5(pg_get_triggerdef(t.oid))
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal;

select 'object', 'function', p.oid::regprocedure::text,
       md5(pg_get_functiondef(p.oid) || '|'
           || coalesce((select string_agg(a::text, ',' order by a::text)
                          from unnest(p.proacl) as a), ''))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f', 'p');

select 'object', 'schema_owner', 'public', pg_get_userbyid(nspowner)
from pg_namespace where nspname = 'public';

-- Roles: the ones a restore target must have before pg_restore (pg_dump does not dump roles).
select 'role', r.rolname, 'attributes',
       concat_ws(',', 'super=' || r.rolsuper, 'bypassrls=' || r.rolbypassrls,
                 'login=' || r.rolcanlogin, 'createrole=' || r.rolcreaterole,
                 'createdb=' || r.rolcreatedb, 'replication=' || r.rolreplication)
from pg_roles r
where r.rolname in ('rampsmith_app', 'rampsmith_worker', 'rampsmith_migrator', 'rampsmith_api',
                    'rampsmith_ctl', 'rampsmith_engine');

select 'role', m.rolname, 'member_of',
       coalesce((select string_agg(g.rolname, ',' order by g.rolname)
                   from pg_auth_members am join pg_roles g on g.oid = am.roleid
                  where am.member = m.oid), '')
from pg_roles m
where m.rolname in ('rampsmith_app', 'rampsmith_worker', 'rampsmith_migrator', 'rampsmith_api',
                    'rampsmith_ctl', 'rampsmith_engine');

commit;
