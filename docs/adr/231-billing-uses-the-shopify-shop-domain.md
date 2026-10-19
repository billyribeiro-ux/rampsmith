# ADR-231: Billing uses `shopify::ShopDomain`

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-4 (`crates/billing`), third stream wave (agent W3)

## Context

`crates/billing` branched from `r0-foundations` at `e43f546`, before `crates/shopify` existed.
It validated shop domains with its own `billing::ShopDomain`, and ADR-131 recorded that the
copy should go once the branch met `crates/shopify`, which has a `shopify::ShopDomain` with
the same rule: `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`, lower-cased, at most 255 characters
(`shopify_shops.shop_domain`'s check constraint). Two types for one identifier let a value
pass one validator and fail the other, and a shop domain read from storage or a session
token's `dest` is already a `shopify::ShopDomain` by the time billing is called.

The architect ruling of 19 October 2026 (docs/STATUS.md, "Third stream wave") said to replace
the copy when the first-wave branches are brought current.

## Decision

1. `billing` depends on `rampsmith-shopify` (the workspace's `shopify` entry) and uses its
   `ShopDomain`. `billing::ShopDomain`, `IdError::ShopDomain` and the `FromStr` impl are deleted.
   `billing` does not re-export the type; callers import `shopify::ShopDomain` once.
2. `plan_selection_url` takes `&shopify::ShopDomain`. `shopify::ShopDomain` has no
   `store_handle()`, and `crates/shopify` is not this stream's to change, so billing derives the
   handle from `as_str()` in a private function (the domain without `.myshopify.com`).
3. The local module is named `shopify`, like the crate. Inside it the crate is written
   `::shopify::ShopDomain`, and `lib.rs` re-exports with `self::shopify::...`, so neither path
   is ambiguous.
4. `plan_selection_url` puts the store handle in a URL path without percent-encoding because
   the validated domain holds only `[a-z0-9-]` before the suffix. A test now pins that part of
   the other crate's rule: every domain that could change the URL (`a.b.myshopify.com`,
   `shop.myshopify.com/`, `https://shop.myshopify.com`, `shop_1.myshopify.com`, and the other
   shapes the old test listed) must be refused by `shopify::ShopDomain::parse`.

## Consequences

- One shop-domain rule in the workspace. A future change to it in `crates/shopify` that
  loosened the character set would fail billing's test before it could build a different URL.
- `billing` gains a path dependency whose own dependencies (`jsonwebtoken`, `reqwest`) were
  already in the lockfile. It uses the type only: no socket is opened and no token handled, so
  the crate stays pure logic.
- Optional follow-up for whoever owns `crates/shopify`: a `store_handle()` method on
  `ShopDomain` would let billing delete its private function.

## Rejected alternatives

- Keeping both types with a conversion: the duplicate rule is the thing to remove.
- Re-exporting the type from billing: it would hide where the type lives and invite a second
  import path.
- Adding `store_handle()` to `crates/shopify` in this branch: that crate belongs to another
  lane and the stream may not edit it.
