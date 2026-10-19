# ADR-054: The content security policy names Shopify's script directory, not the CDN host

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-023 (web skeleton, headers), PLAN §18
- Fixes: R0 security audit M3

## Context

ADR-023 gave SvelteKit's `csp` option `script-src 'self' https://cdn.shopify.com` so the embedded
App Home could load App Bridge and Polaris. `cdn.shopify.com` is not only where Shopify
publishes its scripts: the audit notes that it also serves files merchants upload
(`/s/files/...`). Anyone who can put a JavaScript file there and finds an injection point in one
of our pages could run it in our origin. The policy also had no `default-src`, so images, fonts,
frames, workers and `fetch` were unrestricted.

Facts checked on 19 Oct 2026:

- Shopify's page on Polaris 2 (`shopify.dev/docs/apps/build/app-home/polaris2`) names both
  scripts: `https://cdn.shopify.com/shopifycloud/app-bridge.js` and
  `https://cdn.shopify.com/shopifycloud/polaris-2.0-rc.js`. The page mentions no other host and
  no content security policy. The layout loads `app-bridge.js` and `polaris-1.1.js` from the same
  directory.
- Shopify requires only `frame-ancestors` of an embedded app (ADR-023, unchanged).
- A developer on `community.shopify.dev` (`/t/polaris-security/38717`, 19 Oct 2026, no answer
  from Shopify yet) reports that Polaris, loaded from its script tag, has no documented
  integrity hash, nonce or hash option, and that he must therefore allow inline styles.
- `cdn.shopify.com` cannot be reached from the build sandbox, so the scripts themselves could not
  be read to list what they load. That is the one thing this ADR cannot prove (see Unverified).

## Decision

`apps/web/src/lib/server/headers-policy.ts` holds the directives; `vite.config.ts` passes them to
SvelteKit. The header on every rendered page is:

```
default-src 'self'
script-src 'self' https://cdn.shopify.com/shopifycloud/ 'nonce-<per request>'
style-src 'self' 'unsafe-inline' https://cdn.shopify.com/shopifycloud/ https://cdn.shopify.com/static/fonts/
img-src 'self' data: https://cdn.shopify.com/shopifycloud/
font-src 'self' https://cdn.shopify.com/shopifycloud/ https://cdn.shopify.com/static/fonts/
connect-src 'self'
object-src 'none'; base-uri 'self'; form-action 'self'
frame-ancestors <per shop for /app, 'none' elsewhere>      (hooks.server.ts, unchanged)
```

1. **Scripts.** A source ending in `/` matches every file below that directory and nothing
   else, so `/shopifycloud/` is allowed and `/s/files/...`, `/static/...` and a sibling such as
   `/shopifycloud-evil/` are not. SvelteKit's nonce (`mode: 'auto'`: nonces for rendered pages,
   hashes for prerendered ones) is the only way to run an inline script. No `unsafe-inline`, no
   `unsafe-eval`, no `strict-dynamic`.
2. **Everything else falls back to `default-src 'self'`**, and the directives above name what
   the pages need beyond that: the images, fonts and styles Shopify's scripts may load are
   assumed to come from the same `/shopifycloud/` directory; `https://cdn.shopify.com/static/fonts/`,
   where Polaris React's documentation puts the admin's Inter font, is allowed for fonts and
   styles only, never for scripts. Both are best guesses: Polaris 2 says only that it "loads the
   correct faces", without naming a host. `connect-src 'self'` states what PLAN §16 already
   guarantees: the browser calls only this origin, never `api`.
3. **Inline styles are allowed** (`'unsafe-inline'` in `style-src`), the one place this policy is
   looser than ideal. Polaris puts styles into its components' shadow roots when it runs and
   Shopify documents no nonce or hash for it, so a stricter `style-src` would break the embedded
   UI in a way no test here can show. Script execution is not affected: inline styles cannot run
   script. SvelteKit adds no style nonces while `'unsafe-inline'` is present, which also lets
   `app.html`'s `<div style="display: contents">` stand.
4. **No `report-uri`.** The app has no endpoint to receive reports; the dev-store check below uses
   the browser console instead.

A path in a source list is not compared after a redirect (CSP Level 3, "Does url match expression
in origin with redirect count?" skips the path when the request was redirected). If Shopify's
CDN ever redirected a `/shopifycloud/` URL to a merchant file, the browser would run it. Nothing narrower exists: Shopify publishes these scripts
as evergreen, unversioned files, so a hash or SRI pin would break on every Shopify release.

## Tests

- `src/lib/server/headers-policy.test.ts` (6 tests): the directive lists, no bare host, every
  host source ends in `/`, no `unsafe-inline`/`unsafe-eval` for scripts, `default-src 'self'`.
- `tests/app.spec.ts` (embedded project, real Chromium, real built app):
  - `the built app sends the pinned content security policy`: the header of `/`, `/nope` and
    `/app?shop=...` parsed and compared with a policy written out in `tests/csp.ts`, one nonce
    each, `frame-ancestors` per route.
  - `scripts run from Shopify's script directory and from nowhere else`: the page loads App Bridge
    and Polaris under the policy with no violation; a script added from
    `/shopifycloud/later-chunk.js` runs; scripts from `/s/files/...`, `/shopifycloud-evil/`,
    `/static/fonts/` and `evil.example`, and an inline script without the nonce, are refused
    (`request.failure()` names the policy, the console reports `script-src`, nothing ran).
  - The existing embedded, home and 404 tests assert zero Content Security Policy console errors.
- `tests/dashboard.spec.ts` (dashboard project): the sign-in page carries the same pinned policy,
  and registering, signing out and signing in with a passkey produce no violation.
- Without the fix (`script-src 'self' https://cdn.shopify.com`), both new embedded tests fail:
  the header differs and the three non-Shopify-script addresses on the CDN host run.

## Unverified, to check on a development store (ADR-023's dev-store runbook)

The real App Bridge and Polaris scripts were not available, so the tests use stand-ins that run
the page's own code under the real policy. On first load inside Shopify admin, read the browser
console for `Content Security Policy` errors. If Shopify's scripts need more, add the narrowest
source that fits, in `headers-policy.ts`, with the console line in the commit message:

- `connect-src`: a beacon or API host. A blocked beacon prints an error and breaks nothing we
  know of.
- `font-src` / `img-src` / `style-src`: another path or host for Polaris' fonts or icons. A
  blocked font falls back to the system font.
- A second script path. App Bridge or Polaris failing to load would show as the page staying on
  "Rampsmith is connecting to your store."

## Plan correction

PLAN §18 (`script-src` bullet) reads "per-request nonces plus Shopify's CDN". It should read: per-request
nonces plus `https://cdn.shopify.com/shopifycloud/` (that directory, not the host), with
`default-src 'self'` and explicit `connect-src`, `img-src`, `font-src` and `style-src`; inline
styles are allowed (ADR-054).

## Rejected alternatives

- Keep the host and rely on nonces: the nonce does not constrain `<script src>` from an allowed
  host once an injection exists, which is the case M3 describes.
- `strict-dynamic` with a nonce on the Shopify tags: needs a nonce on the tags in
  `routes/app/+layout.svelte`, and lets App Bridge's own scripts load anything. The directory
  allow-list is narrower.
- A strict `style-src` with nonces: unverifiable here and a visible regression if wrong. To be
  revisited when Shopify documents a nonce or hash for Polaris, or the dev-store check shows
  Polaris works without inline styles.
- A `Content-Security-Policy-Report-Only` copy of a stricter policy: SvelteKit refuses one without
  `report-uri` or `report-to`, and there is no endpoint to receive reports.
