-- The token state of the shop behind one `shopify.token_refresh` job (ADR-178). Break-glass: it
-- reads across tenants.
--
--   railway connect postgres --ssh          (as the database superuser, in a private terminal)
--   \set job 00000000-0000-0000-0000-000000000000
--   \i docs/runbooks/sql/jobs-token-state.sql
--
-- It answers "how long do I have": a refresh job that died means that shop's weekly keep-alive
-- chain is broken, and its refresh token expires 90 days after it was issued (PLAN §14). If no
-- token columns come back, the tokens are gone (Shopify revoked them, or the shop uninstalled):
-- retrying cannot help and the merchant re-authenticates the next time they open the app.
-- The shop is named by its id, not its domain.
--
-- Like master-key-usage.sql it refuses any role that row-level security applies to.

\set ON_ERROR_STOP on

\if :{?job}
\else
  \warn 'refused: pass the job id, for example \set job 00000000-0000-0000-0000-000000000000'
  do $$ begin raise exception 'jobs-token-state.sql needs the psql variable job=<uuid>'; end $$;
\endif

select (rolsuper or rolbypassrls) as sees_every_tenant
  from pg_roles
 where rolname = current_user
\gset

\if :sees_every_tenant
\else
  \warn 'refused: this query must run as the database superuser (break-glass, PLAN section 18)'
  do $$ begin raise exception 'jobs-token-state.sql needs a role that bypasses row-level security'; end $$;
\endif

select s.id as shop_id,
       s.status as shop_status,
       t.key_id,
       t.access_expires_at,
       t.refresh_expires_at,
       round(extract(epoch from t.refresh_expires_at - now()) / 86400, 1) as refresh_days_left,
       j.state as job_state,
       coalesce(j.last_error ->> 'code', '(none)') as job_error_code
  from jobs j
  join shopify_shops s on s.id = (j.payload ->> 'shop_id')::uuid
  left join shopify_tokens t on t.shop_id = s.id
 where j.id = :'job'
   and j.queue = 'shopify.token_refresh';
