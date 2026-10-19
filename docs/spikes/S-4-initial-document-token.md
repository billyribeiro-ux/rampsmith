# Spike S-4: how the initial document request carries the ID token

- Date: 2026-10-17
- Question (PLAN §14): for a non-Remix embedded app, does Shopify's first request for the app's
  HTML carry the session (ID) token, as a search parameter or a header, so a SvelteKit hook can
  authenticate it?
- Status: answered from the official documentation; live observation on a development store is
  pending the founder's Shopify Partner account (see "Still to observe").

## Evidence

Read on 2026-10-17:

1. [ID tokens](https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens):
   "App Bridge issues an ID token to your app's frontend"; "your frontend sends the ID token to
   your backend"; App Bridge's fetch interceptor "adds the ID token to requests to your app's
   domain automatically"; outside a standard fetch, call `shopify.idToken()`. Tokens expire one
   minute after issue and "may return a cached token with less than the full minute
   remaining". The page documents no search parameter or header on the document request.
   Claims to validate: `exp` in the future, `nbf` in the past, `aud` equal to the client id,
   and "the hostnames of `iss` and `dest` must match". HS256 with the client secret. Reject with
   401 before calling the token endpoint.
2. [Authenticate an embedded app without a template](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange):
   "Include the ID token in the `Authorization` header on requests from your frontend to your
   backend." Its reference server serves `/` and `/index.html` unauthenticated: it reads
   `public/index.html`, replaces `%SHOPIFY_API_KEY%` with the client id so App Bridge can
   initialise, and sends it. A stale token answers `401` with
   `X-Shopify-Retry-Invalid-Session-Request`; "App Bridge intercepts the response, fetches a
   fresh ID token, and retries the request once." Token exchange sends
   `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token` and
   `expiring=1`; a `400` from Shopify means the ID token is stale.
3. [Offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens):
   each refresh returns a new pair; the presented refresh token stays usable until the newer
   one is used, a new token is acquired (which "retires every other refresh token for that app
   on that store"), 30 days after its first use, or its 90-day expiry. "Don't do the two at the
   same time for the same store." Public apps must use expiring offline tokens by
   1 January 2027. Read `expires_in` instead of hard-coding it.

## Answer

The documented contract for an app without a Shopify template is: the document request is
not authenticated; the HTML carries no merchant data; every data request carries
`Authorization: Bearer <ID token>`. Rampsmith builds exactly that (ADR-022):

- `web` serves the embedded shell (App Bridge script and `shopify-api-key` meta first in
  `<head>`) without reading any token, with server-side rendering off for embedded routes.
- Client code fetches same-origin `web` endpoints with a token from `shopify.idToken()` in the
  `Authorization` header (explicit, so it does not depend on the interceptor's patching order).
- `web`'s server forwards the header to `api`, which verifies it, exchanges it when the shop
  has no valid offline token, and answers `401` plus `X-Shopify-Retry-Invalid-Session-Request: 1`
  on any invalid or stale token.

Nothing depends on an undocumented `id_token` search parameter. If one is present on the first
load it is ignored.

## Still to observe

On a development store, once the founder's Partner account, app and store exist:

1. Open the app from the admin and record the document request's URL parameters and headers.
2. Confirm App Bridge retries once on the retry header and that a fresh token arrives.
3. Record both in this file, with redacted screenshots of the network panel.
