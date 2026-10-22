# ADR-080: The webhook listener, the compliance topics and the Admin API client

- Status: Accepted
- Date: 2026-10-22
- Refines: PLAN §9, §14, §19; ADR-037, ADR-182
- Fixes: integration audit M1 (webhook dedup on the body digest)

## Context

R1 needs three things from Shopify that R0 left as stubs: webhook deliveries (uninstall and the
three mandatory compliance topics), reads of store data, and a few data writes. The sources, read
on shopify.dev on 22 Oct 2026 for API 2026-10:

- Verify deliveries: `docs/apps/build/webhooks/verify-deliveries` (HMAC-SHA256 of the raw body,
  base64, in `X-Shopify-Hmac-Sha256`, compared in constant time).
- Subscribe over HTTPS: `docs/apps/build/webhooks/subscribe/https` (answer 200 quickly; retries on
  anything else) and `.../ignore-duplicates` (`X-Shopify-Webhook-Id` is stable across retries).
- Privacy law compliance: `docs/apps/build/privacy-law-compliance` (`customers/data_request`,
  `customers/redact`, `shop/redact`; 48 hours after uninstall for `shop/redact`).
- Rate limits: `docs/apps/build/apis/graphql-admin/rate-limits` (calculated query cost, a bucket of
  points refilled per second, `extensions.cost.throttleStatus`, `THROTTLED` error code).
- Objects and mutations: `MediaImage`, `Product`, `Collection`, `Page`, `Article`, `Menu`,
  `shopLocales`, `themes`; `fileUpdate`, `productUpdate`, `collectionUpdate`, `pageUpdate` with
  `userErrors`.

## Decision

**Listener.** `WEBHOOK_BIND_ADDR` starts a second router that serves only `POST /webhooks/shopify`;
every other path is 404 (ADR-182). Order of checks, each before the next costs anything:
in-flight permit (503), signature header present (401), body read under a 256 KiB limit (413),
HMAC over the raw bytes with `verify_slice` (401), then topic, shop domain and webhook-id headers
(400). Only after that is the database touched. The `X-Shopify-Shop-Domain` header is not covered
by the signature; the body is, so a delivery whose header and body name different shops is refused
(401). Unknown shops and unaccepted topics are acknowledged with 200 and not stored.

**Dedup (M1).** An event is stored once per `(tenant, X-Shopify-Webhook-Id)` and, within 24 hours,
once per `(tenant, topic, SHA-256 of the raw body)`. The id headers are not signed, so the digest is
what stops a captured delivery replayed under a new id. The unique key on `external_id` becomes
`(tenant_id, external_id)`: a delivery id is a fact about one tenant's delivery.

**Processing.** The event row and the `webhook.process@1` job are written in one transaction with
the idempotency key `webhook.process:{event_id}`. The worker re-checks the body's shop domain.

- `app/uninstalled`: the worker asks Shopify whether the token still works. A 401 or 403 confirms:
  shop `uninstalled`, tokens deleted, queued work cancelled (the compliance webhook job is kept).
  A working token means a replay, so nothing changes. Shopify unreachable means retry.
- `customers/data_request`, `customers/redact`: Rampsmith holds no customer data (it reads
  products, collections, pages and menus, never orders or customers), so the audit log records
  `none_held` with the request id only. The body, which carries the customer's details, is cleared.
- `shop/redact`: deletes every table that holds the shop's scans, findings, fixes, snapshots,
  statements, AI records and tokens, clears the site settings, marks the shop `redacted`. The
  audit log (append-only, no personal data) and webhook digests stay. Idempotent.
- `shop/update`: refreshes primary domain and locales.

**Admin client** (`crates/shopify-admin`). `AdminFactory` builds an `AdminClient` per shop and token.
One cost bucket per shop is shared by the process (1000 points, 50 per second by default, the
Standard plan), learns each operation's real cost from `extensions.cost`, waits before sending when
the bucket cannot cover the learned cost, and retries `THROTTLED` and HTTP 429 up to three times
with the server's wait. `userErrors` are a typed error, never ignored. Redirects are not followed,
the endpoint is HTTPS-only for Shopify, and a token never appears in a log or an error.
Writes cover only the fields ADR-004 allows: image alt text, and product, collection and page
descriptions. No theme file is ever written.

## Consequences

- The image smoke test passes: unsigned POST gives 401, other paths give 404 on that port.
- `shop/redact` needs `delete` on `scan_pages` and `ai_calls` for the worker role (migration
  `20261103000001`).
- Tests use wiremock with fixtures shaped like the documented responses. Live checks against a
  development store are tracked in `docs/evidence/r1-lane-a.md`.
