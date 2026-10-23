# ADR-085: The webhook trust model: only the body is signed

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-080
- Fixes: lane A audit H1, M1, M2, L5, L10 (see `docs/evidence/r1-lane-a-audit.md`)

## Context

Shopify signs the raw body of a delivery (`X-Shopify-Hmac-Sha256`). The topic
(`X-Shopify-Topic`), the shop (`X-Shopify-Shop-Domain`) and the delivery id
(`X-Shopify-Webhook-Id`) are not covered. ADR-080 trusted the topic after the HMAC check, keyed
body-digest dedup on the topic and let `shop/redact` delete without asking Shopify anything. A
captured signed body of the shop, resent with `X-Shopify-Topic: shop/redact` and a new webhook id,
deleted a live shop's data (audit H1).

## Decision

1. **Shape per topic.** After the HMAC passes, the listener checks that the body looks like the
   documented payload of the claimed topic: `shop/redact` is exactly `{shop_id, shop_domain}` (and
   `shop_id` matches the stored `shop_gid` once a scan recorded it); `customers/data_request` and
   `customers/redact` carry `shop_id`, `shop_domain` and a `customer` object; `app/uninstalled`
   and `shop/update` carry the shop object (`myshopify_domain`, never `shop_domain`). Anything
   else is a 400 and is not stored.
2. **Digest dedup across topics.** `webhook_digests (tenant_id, body_sha256)` is a primary key.
   `record` claims it with one `insert .. on conflict .. do update .. where expires_at <= now()`,
   so two concurrent replays cannot both win (L5). The window is 24 hours, and 40 hours for
   `*/redact`, which is over a day yet under the 48 hours that must pass between two genuine
   `shop/redact` deliveries of one shop (the second needs a reinstall, an uninstall and Shopify's
   48 hour delay).
3. **The grant is the authority.** `shop/redact` for a shop still `installed` runs the same
   grant check as `app/uninstalled`: a working token means the delivery is a replay (audit
   `compliance.shop_redact_ignored`, event marked processed, nothing deleted); a 401 marks the shop
   uninstalled and redacts; any other answer retries. A shop already `uninstalled` or `redacted`
   is redacted without asking Shopify, because no grant remains to check.
4. **One 401 rule.** The grant check is `query { shop { id } }`, which needs no access scope. Only
   HTTP 401 confirms that a grant is gone. ADR-080 said "401 or 403"; Shopify's own
   `@shopify/shopify-app-express` 8.0.3 (`dist/cjs/middlewares/has-valid-access-token.js`, from
   registry.npmjs.org) proves a token with `{ shop { name } }` and treats only a 401
   `HttpResponseError` as "re-authenticate"; no Shopify package treats a 403 as an uninstall, and a
   403 can mean a missing scope or a frozen shop, so it would let a replayed uninstall end a live
   shop. A 403 is retried.
5. The worker compares the body's shop domain with the stored one ignoring ASCII case.

## Consequences

- A relabelled or replayed signed body cannot delete a live shop, even if every listener check
  were bypassed.
- A genuine `shop/redact` for a shop whose token is still accepted is ignored on purpose; Shopify
  sends it only after the merchant removed the app, at which point the token is dead.
- Migration `20261105000002` adds `webhook_digests` and drops `webhook_events_body`.

## Rejected alternatives

- Window on the topic only: the topic is unsigned.
- A 30 day window for redact topics: it could swallow a genuine second redact.
- Trusting `shop_id` alone: it is only known after the first scan.
