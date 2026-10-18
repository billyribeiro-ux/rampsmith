# ADR-162: App proxy contract for barrier reports (for the api)

- Status: Accepted (contract); the api implements it
- Date: 2026-10-18
- Stream: WS-7, written for the main builder, who owns `crates/api` and the migrations

## Context

The theme app extension's barrier-report form (ADR-161) posts through a Shopify app proxy.
PLAN §14 says only "posts through a signed app proxy"; PLAN §19 lists "Barrier reports from
shoppers (optional form) | Theme app embed | Passed to the merchant | 12 months; deletable by
the merchant" and the compliance webhooks' handling of them. Nothing serves the proxy yet.

Checked on shopify.dev on 17 and 18 October 2026:

- [About app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies):
  configured in `shopify.app.toml` under `[app_proxy]` with `url`, `prefix` (`a`, `apps`,
  `community` or `tools`) and `subpath` (letters, digits, `_` and `-`, up to 30 characters,
  not `admin`, `services`, `password` or `login`); "Configuring an app proxy requires the
  `write_app_proxy` access scope"; one proxy per app; child paths are appended
  (`/apps/<subpath>/child` goes to `<url>/child`); merchants can customise the prefix and
  subpath per store, and changes to `prefix` and `subpath` apply only to new installations;
  links must not hard-code the path but read the `path_prefix` parameter "Shopify adds to every
  proxied request". A response with `Content-Type: application/liquid` is rendered in the
  shop's theme; any other response "is returned directly to the client"; "any 30x redirects
  are followed". Shopify strips these response headers: Accept-Patch, Accept-Ranges,
  Connection, Cookie, Date, Delta-Base, IM, P3P, Pragma, Preference-Applied,
  Proxy-Authenticate, Public-Key-Pins, Server, Service-Worker-Allowed, Set-Cookie, Trailer, Tk,
  Warning, X-Powered-By.
- [Authenticate app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies):
  Shopify adds `shop`, `logged_in_customer_id` (empty when no customer is logged in),
  `path_prefix`, `timestamp` (Unix seconds) and `signature`, and the `X-Forwarded-Host` and
  `X-Forwarded-For` headers; other parameters may appear. `signature` is a hex HMAC-SHA256,
  keyed with the app's client secret, of the other parameters: decoded, `key=value`, repeated
  values joined by commas, sorted, concatenated with no separator. Both the request method and
  body are forwarded; only the query is signed. "The signature check only guarantees that the
  request hasn't been tampered with"; it does not authenticate the shopper.
- [Requirement 5.1.5](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements):
  data collected from customers through the Online Store must be returned to the merchant's
  Shopify admin and be accessible to the merchant.

Shopify's two worked examples (secret `hush`, shop `shop-name.myshopify.com`, timestamp
`1317327555`) reproduce exactly in `packages/theme-app-ext-test/src/app-proxy-signature.ts`:
`4c68c862…7395ddb` with `logged_in_customer_id=1` and `e072b6d7…ff8093cb` with it empty. The page
shows `{shop}` as a placeholder; the signatures match only with `shop-name`. Those vectors are
the api's test vectors.

## Decision

### Configuration (integrator: shared files)

`shopify.app.toml` gains the scope and the proxy:

```toml
[access_scopes]
scopes = "read_products,write_products,read_files,write_files,read_themes,read_content,write_content,read_online_store_navigation,write_online_store_navigation,read_locales,write_app_proxy"

[app_proxy]
url = "https://<api host>/shopify/app-proxy"
prefix = "apps"
subpath = "rampsmith"
```

So `https://<shop>/apps/rampsmith/barrier-report` reaches
`https://<api host>/shopify/app-proxy/barrier-report`. The URL is per environment (production
and staging apps, LAUNCH.md C rows 1 and 15).

### Endpoint

`POST /shopify/app-proxy/barrier-report`. Any other method answers `405` with `Allow: POST`;
any other path under `/shopify/app-proxy/` answers `404`. Every answer carries
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and none sets a cookie.

The api checks, in this order, and stops at the first failure:

1. **Signature** (`401 {"status":"unauthorized"}`). From the raw query string: exactly one
   `signature`, 64 lowercase hex digits; recompute over every other parameter as above with
   `SHOPIFY_API_SECRET` (LAUNCH.md C row 1) and compare in constant time (`hmac`'s
   `verify_slice`). A malformed signature is refused before any comparison.
2. **Shop and freshness** (`401`). Exactly one `shop`, matching
   `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`; exactly one `timestamp`, 1 to 12 digits, no older
   than 300 seconds and no more than 30 seconds ahead of the api's clock. Shopify signs each
   request as it forwards it and never shows the signed query to the shopper, so the window
   only bounds the replay of a captured server-side request.
3. **Install** (`404 {"status":"unavailable"}`). `app_shop_by_domain(shop)` (ADR-022) finds an
   installed shop; an uninstalled or unknown shop, or one whose merchant has switched reports off
   in the app, gets this answer.
4. **Media type** (`415 {"status":"unsupported_media_type"}`). The body is
   `application/x-www-form-urlencoded` (optionally with `charset=UTF-8`), which a plain form
   post and the extension's script both send.
5. **Size** (`413 {"status":"too_large"}`). The body is read with a 32 KiB limit; a maximal
   report in a non-Latin script percent-encodes to about 25 KB.
6. **Rate limits** (`429 {"status":"rate_limited"}` with `Retry-After` in seconds). Counted on
   every request that passed steps 1 to 5: per shop 30 an hour and 200 a day; per client 5 in
   10 minutes and 20 a day. The client key is HMAC-SHA256 of the client IP under a key that
   rotates daily and is never stored; it lives only in the limiter, which keeps nothing longer
   than a day. The client IP is the address Shopify appends to `X-Forwarded-For`; Railway's edge
   appends one more hop after it, so the api takes the entry its configured number of trusted
   hops from the right, never the left-most one a client can set. Until the header's shape is
   recorded on staging (live check, LAUNCH.md section E), per-shop limits are the authoritative
   guard.
7. **Body rules** (reference: `packages/theme-app-ext-test/src/barrier-report.ts`, held to its
   tests). The first value of each field is used and unknown fields are ignored.
   - `website` (the honeypot) not blank, or `elapsed_ms` present, numeric and under 3000:
     answer exactly as for an accepted report and store nothing.
   - `description`: CRLF to LF, NFC, C0 and C1 controls (except tab and line feed) and the
     bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069) removed,
     trimmed; required; at most 2000 UTF-16 code units, as the form's `maxlength` counts.
   - `email`: trimmed; optional; at most 254 characters and the WHATWG "valid email address"
     production that `<input type="email">` enforces.
   - Errors answer `400 {"status":"invalid","errors":[{"field":"description","code":"missing"}]}`
     with codes `missing` and `too-long` for `description` and `invalid` for `email`. The
     script shows these next to their fields.
   - `page`: kept only if it starts with `/`, not `//` or `/\`, has no control character and is
     at most 2048 characters; otherwise null. `page_type`: kept only if it is one of the 22
     documented `request.page_type` values. `locale`: kept only if it matches
     `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8}){0,4}$` and is at most 35 characters.
   - `logged_in_customer_id`, `path_prefix` and every other query parameter are never stored.
8. **Duplicates.** The same shop, description and email within 24 hours: answer as accepted and
   store nothing new.
9. **Store and answer** `200 {"status":"received"}`.

The answer's format follows `Accept`: `application/json` gets the JSON bodies above (the
script sends that). Anything else is a plain form post: the api answers `Content-Type:
application/liquid` with a short page, which Shopify renders in the theme: a heading, one
sentence, and a link back. Its strings are the api's own, in the report's `locale` with
English as the fallback, and pass `claims-lint`. The page never contains the description, the
email or any other submitted text, and no input is ever placed into Liquid source; the link
back is `/`, or the validated `page` with every character outside `A-Z a-z 0-9 - . _ ~ /`
percent-encoded, so no Liquid or HTML syntax can survive into it. No redirect is used, since
Shopify follows 30x answers itself.

The client secret never appears in logs; logs carry the tenant id, the outcome code and the
latency, never the query string, signature, body, email, IP or user agent (PLAN §8, §21).

### Data held, and for how long (PLAN §19)

| Field | Kept | Why |
| --- | --- | --- |
| `description` | As cleaned above | What the barrier is |
| `email` | Only if given; encrypted with a per-row data key wrapped by the master key (ADR-021), plus an HMAC-SHA256 lookup hash of its trimmed lowercase form, keyed with a key derived from `RAMPSMITH_MASTER_KEYS` by HKDF-SHA256 (info `barrier-report-email-lookup`), for the compliance webhooks | So the merchant can reply |
| `page`, `page_type`, `locale` | As validated; account pages send only `/account` | Where it happened, in which language |
| `received_at` | Always | Retention and ordering |

Not collected: names, IP addresses (only the transient limiter key above), customer ids,
cookies, user agents. Rampsmith processes the reports for the merchant (processor; PLAN §19).

- **Retention:** 12 months from `received_at`, then deleted by the scheduler; the merchant can
  delete any report at any time.
- **`customers/data_request`:** reports whose lookup hash matches the payload's customer email
  are exported to the merchant; otherwise the answer is that none are held.
- **`customers/redact`:** those reports are deleted.
- **`shop/redact`:** every report of the shop is deleted with the rest of its data.
- **Requirement 5.1.5:** every report is listed in the embedded App Home, with delete and CSV
  export; no Shopify customer record is created (no customer scopes are requested).

### Storage (main builder)

A tenant-owned `barrier_reports` table under `TenantTx` and row-level security, with the
isolation suite extended to it: `id` (UUIDv7), `tenant_id`, `shop_id`, `description`,
`email_ciphertext` (nullable), `email_key_id`, `email_lookup` (nullable, indexed per tenant),
`page`, `page_type`, `locale`, `received_at`, `dedupe_hash` (SHA-256 of shop, description and
email, unique per shop within the 24-hour window, enforced by the insert). A new report
enqueues `barrier_report.notify`, which emails the merchant a daily digest at most (WS-10's
templates) and never includes the shopper's email address in the subject.

### Abuse and spam

The signature makes every report provably the shop's; it cannot tell a person from a bot. The
honeypot, the 3-second floor (script only), the rate limits and duplicate suppression do that,
all answering bots as if they succeeded. No CAPTCHA: it would add a third-party script and
cookies to every storefront page and an accessibility barrier of its own. A cross-site post to
the proxy has no ambient authority to abuse (`logged_in_customer_id` is ignored), so it is
spam like any other and meets the same limits. A merchant who sees abuse turns the form off in
the embed settings; the api can switch reports off per shop (step 3).

## Consequences

- The api needs `SHOPIFY_API_SECRET` (already row 1) and the `write_app_proxy` scope, which
  merchants grant at install. Adding a scope later asks installed merchants to approve it, so it
  goes in before R1's design partners install.
- Live checks (LAUNCH.md section E): a report through the real proxy on development store A
  (rows 1, 3 and 8), and the `X-Forwarded-For` shape recorded on staging (row 8).
- The api's Rust tests use Shopify's two vectors and the reference module's cases.

## Plan correction

PLAN §14 "Access scopes", add a row: "`write_app_proxy` | Serve the barrier-report form's app
proxy (`/apps/rampsmith`); Shopify requires it to configure a proxy (ADR-162)".

PLAN §14 "Webhooks" is unchanged; add after it a subsection "App proxy" that points to ADR-162:
`POST /apps/rampsmith/barrier-report` to the api's `/shopify/app-proxy/barrier-report`,
signature checked in constant time over the query, timestamp within 300 seconds, 401 on any
failure, per-shop and per-client limits, honeypot and timing checks.

PLAN §14 "App Home screens", add a row: "`/reports` | Barrier reports from the storefront form:
read, delete, export (requirement 5.1.5)".

PLAN §18 "Threats and controls", add a row: "Forged or flooded barrier reports | App proxy
signature and freshness check, per-shop and per-client limits, honeypot, timing floor,
duplicate suppression; nothing submitted is ever reflected (ADR-162)".

PLAN §19 "Data inventory", replace the barrier-report row's Source and Purpose with "Theme
app embed, through the app proxy | Passed to the merchant; email encrypted, only if given" and
keep "12 months; deletable by the merchant".
