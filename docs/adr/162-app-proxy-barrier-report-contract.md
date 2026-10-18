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
url = "https://<webhook host>/shopify/app-proxy"
prefix = "apps"
subpath = "rampsmith"
```

So `https://<shop>/apps/rampsmith/barrier-report` reaches
`https://<webhook host>/shopify/app-proxy/barrier-report`. The proxy is served from the public
webhook host PLAN §22 already has, never from a public domain on `api` itself (which would
expose every route; ADR-005): the edge allowlist of that host gains exactly
`POST /shopify/app-proxy/barrier-report`, matched on the raw path, with any path that
normalises differently (`..`, `//`, encoded slashes) refused at the edge. The URL is per
environment (the production and staging apps, LAUNCH.md C rows 1 and 15).

### Endpoint

`POST /shopify/app-proxy/barrier-report` is the only route. Anything else under the prefix
(another path, or another method on this path) answers `404 not_found` with a problem body,
whatever its `Accept`, and the edge refuses it first anyway. Nothing under the prefix ever
redirects, trailing-slash redirects included. Every answer carries `Cache-Control: no-store`
and `X-Content-Type-Options: nosniff`, none sets a cookie or a CORS header, and JSON answers
also carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.

**Answers.** Success is `200 application/json` `{"status":"received"}`. Every error is an RFC
9457 `application/problem+json` body whose `code` comes from `crates/contracts`'
`ProblemCode`, so the contract adds no code: `unauthenticated` (401), `not_found` (404),
`bad_request` (400, for a wrong media type), `payload_too_large` (413), `validation_failed`
(422, with an `errors` member; the script reads field errors from a 422), `rate_limited` (429,
with `Retry-After`) and `internal` (500). The shared http-kit middleware passes problem bodies
through unchanged. A POST whose `Accept` does not include `application/json` is a plain form
post: it gets a `200 application/liquid` page whatever the outcome, which Shopify renders in the
theme, and the page says what happened. The route sets its own 32 KiB body limit below the
global one.

**Parsing (applies to every step).** The raw query is parsed once into an ordered list of
pairs with `form_urlencoded::parse`, never `axum::extract::Query` or `serde_urlencoded`,
which drop repeated keys. More than 64 pairs is refused (`401`) before anything else. Every
check below reads from that one parse. The body is not read at all until steps 1 to 5 pass.

The api checks, in this order, and stops at the first failure:

1. **Signature** (`401 unauthenticated`). Exactly one `signature`, 64 lowercase hex digits;
   the message is every other pair, decoded, as `key=value` with repeated keys' values joined
   by commas, the whole strings sorted by bytes (not by key: `a-b=2` sorts before `a=1`), and
   concatenated; the HMAC-SHA256 with `SHOPIFY_API_SECRET` (LAUNCH.md C row 1) is compared in
   constant time (`hmac`'s `verify_slice`). A malformed signature is refused before any
   comparison. The format has no separators, so `a=1b=2` and `a=1&b=2` sign alike; that is
   safe only because the signed query is never shown to the shopper and every identity
   parameter must appear once (step 2).
2. **Reserved parameters** (`401`). Exactly one `shop`, matching
   `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`; exactly one `timestamp`, 1 to 12 digits, no older
   than 300 seconds and no more than 30 seconds ahead of the api's clock; exactly one
   `path_prefix`, matching `^/(a|apps|community|tools)/[A-Za-z0-9_-]{1,30}$`; at most one
   `logged_in_customer_id`, digits or empty. Shopify does not document what it does with a
   reserved parameter a client puts in the storefront URL. Refusing every repeat means a
   client's value can never stand beside or in front of Shopify's; it cannot catch Shopify
   passing a client's value through when it adds none of its own. The live check therefore
   sends each reserved parameter both repeated and alone through the real proxy and records
   what the api receives; if the api ever receives a client's value, integration stops and the
   founder is told before the endpoint ships.
3. **Install** (`404 not_found`). `app_shop_by_domain(shop)` (ADR-022) finds an installed
   shop; an uninstalled or unknown shop, or one whose merchant has switched reports off in the
   app, gets this answer.
4. **Media type** (`400 bad_request`). The body is `application/x-www-form-urlencoded`
   (optionally with `charset=UTF-8`), which a plain form post and the extension's script both
   send.
5. **Per-client limit** (`429`). 5 in 10 minutes and 20 a day, in process (`governor`, PLAN
   §7). The key is HMAC-SHA256, under a key that rotates daily and is never stored, of the
   client address: IPv4 as is, IPv4-mapped IPv6 folded to IPv4, other IPv6 by its /64. The
   address is the `X-Forwarded-For` entry that Shopify appended, found by counting the hops the
   api trusts from the right (Railway's edge, and Cloudflare's if the host is proxied), never
   the left-most entry a client can write. The limiter holds at most 100,000 keys, evicting the
   least recently used when full rather than refusing new clients, and nothing older than a
   day. In-process limits apply per api instance. Until the header's shape is recorded on
   staging (live check), the per-shop limits below are the authoritative guard.
6. **Size** (`413 payload_too_large`). At most 32 KiB; a maximal report in a non-Latin script
   percent-encodes to about 25 KB.
7. **Replay** (answered `200 received`, nothing stored). For 330 seconds the api keeps the
   SHA-256 of each signature together with the SHA-256 of its body, in a cache bounded like the
   limiter. Only an exact repeat of a (signature, body) pair is a replay. One signature with
   different bodies is not refused: every anonymous shopper of a shop shares a signature within
   a second, since only the query is signed, so a cap per signature would let one client block
   the others. A captured signature gains nothing beyond what the limits allow. No route under
   the prefix treats the signature as proof of who the shopper is.
8. **Shop-wide load cap** (`429`). 300 requests an hour per shop, in process, counting only
   requests that passed the per-client limit, so one client cannot spend it for everyone.
9. **Body rules** (reference: `packages/theme-app-ext-test/src/barrier-report.ts`, held to its
   tests). The first value of each field is used and unknown fields are ignored.
   - `website` (the honeypot) not blank, or `elapsed_ms` present, numeric and under 3000:
     answer exactly as for an accepted report and store nothing.
   - `description`: CRLF and U+2028/U+2029 to LF; C0 and C1 controls (except tab and line
     feed), the bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069), the
     zero-width space (U+200B), word joiner (U+2060) and byte-order mark removed; then NFC;
     then trimmed. Zero-width (non-)joiners and directional marks stay, because scripts such as
     Persian, Hindi and Arabic need them. Required; at most 2000 UTF-16 code units, as the
     form's `maxlength` counts. In the Rust port these characters are written as escapes,
     never literally (rustc denies literal bidi characters).
   - `email`: trimmed; optional; at most 254 characters and the WHATWG "valid email address"
     production that `<input type="email">` enforces.
   - Errors answer `422 validation_failed` with
     `"errors":[{"field":"description","code":"missing"}]`: codes `missing` and `too-long` for
     `description`, `invalid` for `email`. The script shows these next to their fields.
   - `page_type`: kept only if it is one of the 22 documented `request.page_type` values.
     `page`: kept only for a public page type (`404`, `article`, `blog`, `cart`, `collection`,
     `index`, `list-collections`, `metaobject`, `page`, `policy`, `product`, `search`), and only
     if it starts with `/`, not `//` or `/\`, is not under an app proxy prefix (`/a/`,
     `/apps/`, `/community/`, `/tools/`, where other apps' pages may carry tokens), has no
     control, bidirectional, invisible (including the Arabic letter mark and the Hangul
     fillers) or whitespace character, and is at most 2048 characters; otherwise null. Account,
     gift card, password and challenge pages can carry order numbers or codes in their paths,
     so the embed sends their type alone and the api would drop a path anyway. `locale`: kept
     only if it matches `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8}){0,4}$` and is at most 35
     characters.
   - `logged_in_customer_id`, `path_prefix` and every other query parameter are never stored.
10. **Stored-report budget** (`429`). 30 stored reports per shop an hour and 200 a day, counted
    in PostgreSQL from `barrier_reports`, so the limit holds across api instances. Discarded,
    invalid and duplicate posts do not count, so nobody can spend a shop's budget without
    being stored.
11. **Duplicates.** The same shop, description and email on the same UTC day: answer as
    accepted and store nothing new (see "Storage").
12. **Store and answer** `200 received`.

**The page for a plain form post** is built only from fixed templates in the api's message
catalog, passing `claims-lint`: a heading, one sentence, and a link back, wrapped in
`{% raw %}…{% endraw %}` so Shopify interprets nothing in it. Outcomes decided before step 9
are written in English; from step 9 on, in the report's validated `locale` with English as the
fallback. The page never contains the description, the email or any other submitted text. The
link back is `/`, or the validated `page` with every character outside
`A-Z a-z 0-9 - . _ ~ /` percent-encoded. A test posts a hostile body and asserts that no
submitted byte appears in the answer.

**Logs and metrics.** The client secret never appears in logs. Logs carry the tenant id, the
outcome code and the latency, never the query string, signature, body, email, IP or user
agent (PLAN §8, §21). Each outcome is a metric, and a rise in signature failures alerts as
webhook signature failures do (PLAN §21). Whether Railway's edge logs keep the full query
(with `logged_in_customer_id` and the signature) is recorded on staging; if they do, the
edge's log settings drop the query for this path, and if Railway cannot do that, the edge
logs' retention and contents are added to PLAN §19's data inventory before the endpoint ships.

### Data held, and for how long (PLAN §19)

| Field | Kept | Why |
| --- | --- | --- |
| `description` | As cleaned above; shown as plain text everywhere (App Home without automatic links, digests, PDFs; passed to any AI prompt only as delimited data) | What the barrier is |
| `email` | Only if given; encrypted with a per-row data key wrapped by the master key (ADR-021), encryption context `barrier_reports/email/<report id>` | So the merchant can reply |
| `email_lookup`, `email_lookup_key_id` | HMAC-SHA256 of the trimmed lowercase email under a lookup key, and that key's id | To find a shopper's reports for the compliance webhooks |
| `page`, `page_type`, `locale` | As validated | Where it happened, in which language |
| `received_at` | Always | Retention and ordering |

Not collected: names, IP addresses (only the transient limiter key above), customer ids,
cookies, user agents. Rampsmith processes the reports for the merchant (processor; PLAN §19).

**Lookup and duplicate keys.** `crates/crypto` derives, for each master key id in
`RAMPSMITH_MASTER_KEYS`, separate purpose keys with HKDF-SHA256 (info
`rampsmith/barrier-report/email-lookup/v1` and `rampsmith/barrier-report/dedupe/v1`); the
master key itself only wraps data keys. The newest key id is used for new rows and stored with
them. A compliance webhook compares the payload's email against the hashes under every key id
in the ring. Before an old master key leaves the ring, the rotation job opens each email it
protects and recomputes `email_lookup` (and the duplicate key) under the newest key, and a test
proves `customers/redact` still finds a report after a rotation.

- **Retention:** 12 months from `received_at`, then deleted by the scheduler; the merchant can
  delete any report at any time.
- **`customers/data_request`:** reports whose `email_lookup` matches the payload's email, or
  whose description mentions the payload's email or phone (`mentionsShopper` in the reference
  module: the email as a literal, case-insensitive whole address, never a `LIKE` pattern,
  whose `_` and `%` would match other shoppers' addresses, and never inside a longer address
  (`ann@x.com` matches neither `joann@x.com` nor `ann@x.com.br`), with SQL
  `strpos(lower(description), lower($1)) > 0` only as a prefilter before the boundary check;
  the phone as digits only, at least 7, matching a digit run that ends with it or that it ends
  with), are exported to the merchant; otherwise the answer is that none are held. A bare
  seven-digit number equal to the phone's last seven digits matches on purpose: missing a
  shopper's report is the worse failure for a compliance request, and the collision is
  unlikely.
- **`customers/redact`:** those reports are deleted.
- **`shop/redact`:** every report of the shop is deleted with the rest of its data.
- The sweep and the compliance handlers run under `TenantTx`, one tenant at a time (or a narrow
  `security definer` function like ADR-022's), never through a connection that bypasses
  row-level security.
- **Requirement 5.1.5:** every report is listed in the embedded App Home, with delete and CSV
  export; no Shopify customer record is created (no customer scopes are requested).
- **CSV export:** every cell quoted, quotes doubled, and a cell that starts, after any leading
  whitespace, with `=`, `+`, `-`, `@`, tab, carriage return or their full-width forms prefixed
  with `'` (`exportCell` in the reference module, with its tests), because every row is text
  from an anonymous visitor.
- **Display:** App Home shows `page` exactly as stored, never percent-decoded (a stored
  `%E2%80%AE` would decode to a right-to-left override), and descriptions as plain text.

### Storage (main builder)

A tenant-owned `barrier_reports` table under `TenantTx` and row-level security, with the
isolation suite extended to it: `id` (UUIDv7), `tenant_id`, `shop_id`, `description`,
`email_ciphertext` and its wrapped data key and key id (nullable), `email_lookup` and
`email_lookup_key_id` (nullable, indexed per tenant), `page`, `page_type`, `locale`,
`received_at`, `received_day` (the UTC date), and `dedupe_key`: HMAC-SHA256 under the dedupe
purpose key of the length-prefixed encoding of (shop id, cleaned description, `email_lookup`
or empty), never a plain hash, which would let anyone holding a backup test candidate emails.
`unique (shop_id, received_day, dedupe_key)` enforces the duplicate rule; the insert's
conflict is the "store nothing new" outcome.

A new report enqueues `barrier_report.notify` with the report id only. It sends the merchant a
daily digest at most (WS-10's templates): fixed subject text, a count and a link into App Home,
never a description or a shopper's email. Nothing is ever sent automatically to the submitted
email address, which is unverified. The `jobs` table's payload holds no shopper data because of
that.

### Abuse and spam

The signature makes every report provably the shop's; it cannot tell a person from a bot. The
honeypot, the 3-second floor (script only), the limits and duplicate suppression do that, all
answering bots as if they succeeded. No CAPTCHA: it would add a third-party script and cookies
to every storefront page and an accessibility barrier of its own. A cross-site post to the
proxy has no ambient authority to abuse: "Shopify strips the `Cookie` header from the request,
and the `Set-Cookie` header from the response" (Authenticate app proxies, re-read 18 October
2026), and `logged_in_customer_id` is ignored, so it is spam like any other and meets the same
limits. A
merchant who sees abuse turns the form off in the embed settings; the api can switch reports
off per shop (step 3).

## Consequences

- The api needs `SHOPIFY_API_SECRET` (already row 1) and the `write_app_proxy` scope, which
  merchants grant at install. Adding a scope later asks installed merchants to approve it, so it
  goes in before R1's design partners install.
- `crates/crypto` gains HKDF purpose keys per master key id (it holds only AES-GCM instances
  today), and the key-rotation job gains the lookup re-hash.
- The query and body parsers join the property-test and fuzzing list in PLAN §18.
- Live checks (LAUNCH.md section E): a report through the real proxy on development store A
  (rows 1, 3 and 8); the reserved parameters a client puts in the URL, sent through the real
  proxy, with what the api received recorded; the `X-Forwarded-For` shape and Railway's edge
  log contents recorded on staging (row 8).
- The api's Rust tests use Shopify's two vectors and the reference module's cases.
- Security audit (security-auditor brief, effort max, 18 Oct 2026): PASS, no critical or high
  findings. Its five medium and ten low findings were fixed in this ADR, ADR-163, the reference
  modules and the extension; the re-verification at commit 7fed777 found 14 of 15 resolved,
  one low (tab and line breaks in the embed's URL checks) open and four new lows (the replay
  cache's body cap, the order of the shop-wide cap, literal matching for the compliance search,
  and wording). Those were fixed, a third round found two more lows (a `/` proxy path, email
  matches inside longer addresses), and the fourth round, at `9dda025`, passed with every
  finding resolved; docs/evidence/ws-7-theme-app-ext.md has each round.

## Plan correction

PLAN §14 "Access scopes", add a row: "`write_app_proxy` | Serve the barrier-report form's app
proxy (`/apps/rampsmith`); Shopify requires it to configure a proxy (ADR-162)".

PLAN §14, add after "Webhooks" a subsection "App proxy": "`POST /apps/rampsmith/barrier-report`
reaches `/shopify/app-proxy/barrier-report` on the webhook host. The api parses the query once,
checks the signature in constant time, requires each reserved parameter once and a timestamp
within 300 seconds, refuses replays, and answers 401 to any failure; then per-shop and
per-client limits, the honeypot and timing checks, and duplicate suppression (ADR-162)."

PLAN §14 "App Home screens", add a row: "`/reports` | Barrier reports from the storefront form:
read, delete, CSV export (requirement 5.1.5)".

PLAN §18 "Threats and controls", add a row: "Forged, replayed or flooded barrier reports |
App proxy signature, reserved-parameter and freshness checks, a replay cache, per-shop and
per-client limits, honeypot, timing floor, duplicate suppression; nothing submitted is ever
reflected, and exports defuse spreadsheet formulas (ADR-162)". PLAN §18 "Verification": add
"the app proxy's query and body parsers" to the property-test and fuzzing list.

PLAN §19 "Data inventory", replace the barrier-report row's Source and Purpose with "Theme
app embed, through the app proxy | Passed to the merchant; email encrypted, only if given" and
keep "12 months; deletable by the merchant". PLAN §19 "Subprocessors": the Railway row's
personal data becomes "Account data, store content, barrier reports".

PLAN §22 "Services", replace the public-hosts sentence with: "The public hosts are the app and
marketing site, and one webhook host that serves only `/webhooks/shopify`, `/webhooks/github`,
`/webhooks/stripe` and `POST /shopify/app-proxy/barrier-report` (ADR-162)."
