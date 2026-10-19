-- Finding stored secrets that a retired master key still wraps (audit L6, ADR-045).
--
-- Master-key rotation prepends a new key to RAMPSMITH_MASTER_KEYS and then re-wraps every stored
-- value under it (ADR-021). The re-wrapping job runs as `rampsmith_worker` across all tenants,
-- but row-level security hides every `shopify_tokens` row until `app.tenant_id` is set, so the
-- job cannot ask which rows are left. These two functions answer that and nothing else: ids and
-- a version for the first, a count per key id for the second. Neither returns ciphertext, and
-- the job reads and writes each row afterwards inside that row's own tenant transaction.
--
-- Security definer: they run as the schema owner, which row-level security does not restrict,
-- like `app_shop_by_domain` (migration 5) and `identity_sweep` (migration 8). Only the worker
-- role may execute them; the api may not.

-- Up to `batch` (1 to 1000) token rows whose key id is not `active_key_id`, in shop id order and
-- after `after_shop` (the last shop of the previous batch; null for the first batch), so a row
-- that cannot be re-wrapped is passed over instead of being returned forever.
create function shopify_tokens_to_rewrap(active_key_id text, after_shop uuid, batch integer)
  returns table (tenant_id uuid, shop_id uuid, version bigint)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.tenant_id, t.shop_id, t.version
    from shopify_tokens t
   where t.key_id <> active_key_id
     and (after_shop is null or t.shop_id > after_shop)
   order by t.shop_id
   limit least(greatest(batch, 1), 1000)
$$;

-- How many token rows each master key id wraps: what an operator checks before removing a key.
create function shopify_token_key_counts()
  returns table (key_id text, tokens bigint)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.key_id, count(*)
    from shopify_tokens t
   group by t.key_id
   order by t.key_id
$$;

revoke all on function shopify_tokens_to_rewrap(text, uuid, integer) from public;
revoke all on function shopify_token_key_counts() from public;
grant execute on function shopify_tokens_to_rewrap(text, uuid, integer) to rampsmith_worker;
grant execute on function shopify_token_key_counts() to rampsmith_worker;
