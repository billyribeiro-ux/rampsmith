-- Which master keys still wrap stored values (ADR-177). Break-glass: it reads across tenants.
--
--   railway connect postgres --ssh          (as the database superuser, in a private terminal)
--   \i docs/runbooks/sql/master-key-usage.sql
--
-- `shopify_tokens.key_id` names the key that wrapped each row's data key. A key may be dropped
-- from the ring only when no table holds its id. Today `shopify_tokens` is the only table with
-- sealed values (crates/db/migrations); when a migration adds another table with a `key_id`
-- column, add it below in the same change.
--
-- Row-level security hides every tenant's rows from a role that does not bypass it, and the
-- policy function raises an error when no tenant is set. This file refuses to run for such a
-- role, so a zero can never be mistaken for "nothing is sealed under this key".

\set ON_ERROR_STOP on

select (rolsuper or rolbypassrls) as sees_every_tenant
  from pg_roles
 where rolname = current_user
\gset

\if :sees_every_tenant
\else
  \warn 'refused: this query must run as the database superuser (break-glass, PLAN section 18)'
  do $$ begin raise exception 'master-key-usage.sql needs a role that bypasses row-level security'; end $$;
\endif

\echo 'stored token rows by wrapping key'
select key_id, count(*) as rows
  from shopify_tokens
 group by key_id
 order by key_id;
