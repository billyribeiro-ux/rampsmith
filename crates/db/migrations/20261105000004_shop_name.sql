-- The shop's display name (`shop { name }`), which `shopify.read_store` and the `shop/update`
-- webhook record so the embedded app's overview can greet the shop by it. Expand only: a
-- nullable column. A name is the merchant's own business name, not customer data (PLAN §19).
alter table shopify_shops
  add column name text check (char_length(name) between 1 and 255);
