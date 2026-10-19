-- Finding a shop's tenant from its domain (ADR-022).
--
-- A Shopify session token names a shop, not a tenant, and row-level security hides every
-- shop row until `app.tenant_id` is set. The api calls this function only after verifying the
-- token's signature and claims, so it returns nothing the caller could not already prove.
-- It reads one exact domain and returns ids and status only. Security definer: it runs as the
-- schema owner, which row-level security does not restrict.
create function app_shop_by_domain(domain text)
  returns table (tenant_id uuid, shop_id uuid, status text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select s.tenant_id, s.id, s.status
    from shopify_shops s
   where s.shop_domain = domain
$$;

revoke all on function app_shop_by_domain(text) from public;
grant execute on function app_shop_by_domain(text) to rampsmith_app, rampsmith_worker;
