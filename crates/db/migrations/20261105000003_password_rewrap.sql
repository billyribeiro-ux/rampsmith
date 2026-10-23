-- Master-key rotation reaches the storefront password too (lane A audit L4).
--
-- `sites.storefront_password_ct` is sealed under the same master key ring as the Shopify
-- tokens, so a retired key is safe to remove only once no site password carries it either.
-- Same shape and same reasons as migration 20261101000002: security definer, ids only, only
-- the worker role may execute.

create function site_passwords_to_rewrap(active_key_id text, after_site uuid, batch integer)
  returns table (tenant_id uuid, site_id uuid)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select s.tenant_id, s.id
    from sites s
   where s.storefront_password_ct is not null
     and s.storefront_password_key_id <> active_key_id
     and (after_site is null or s.id > after_site)
   order by s.id
   limit least(greatest(batch, 1), 1000)
$$;

-- Counts now include the site passwords: what an operator checks before removing a key.
create or replace function shopify_token_key_counts()
  returns table (key_id text, tokens bigint)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select k.key_id, sum(k.n)::bigint
    from (
      select t.key_id, count(*) as n from shopify_tokens t group by t.key_id
      union all
      select s.storefront_password_key_id, count(*)
        from sites s
       where s.storefront_password_key_id is not null
       group by s.storefront_password_key_id
    ) k
   group by k.key_id
   order by k.key_id
$$;

revoke all on function site_passwords_to_rewrap(text, uuid, integer) from public;
grant execute on function site_passwords_to_rewrap(text, uuid, integer) to rampsmith_worker;
