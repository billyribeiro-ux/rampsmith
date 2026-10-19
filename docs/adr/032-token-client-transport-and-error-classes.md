# ADR-032: Token client transport rules and error classes

- Status: Accepted
- Date: 2026-10-19

## Context

The R0 security audit (`docs/evidence/r0-security-audit-2026-10-19.md`) found three low-severity
issues in `crates/shopify`'s `TokenClient`, which posts the app's `client_secret` to
`https://<shop>/admin/oauth/access_token`:

- **L3.** The client followed redirects. A 307 or 308 repeats the POST, form body included, at
  the `Location` URL, so a hostile or misconfigured response could carry the client secret
  elsewhere. Nothing required HTTPS for the real endpoint either.
- **L4.** Only a 401 on refresh was treated as terminal. The audit asked to confirm the rest
  against Shopify's documentation.
- **L7.** The `exchange` and `refresh` spans recorded the shop domain, and PLAN §19 logs ids,
  not domains.

Shopify's documentation, read on 2026-10-19
([Authenticate an embedded app without a template](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange?lang=node)),
says:

- Token exchange: "If the ID token is expired or otherwise invalid, Shopify returns a
  `400 Bad Request`." The app then answers its own caller 401 with
  `X-Shopify-Retry-Invalid-Session-Request`. A 401 in that guide comes from the app's own
  validation, "before reaching Shopify's token endpoint". "Reserve `5xx` responses for failures
  that a fresh ID token can't fix, such as rejected client credentials."
- Refresh: "A 401 is terminal (expired, revoked, replayed outside the retry window, or the app
  was uninstalled)". The sample's comments add: "a 400 for a malformed body, or a 403 for bad
  client credentials, returns the same response no matter how long you wait", "Only a rate limit
  or a server fault is worth retrying", and "Other failures (network, 5xx, 429) are transient and
  safe to retry". Any other non-OK status is surfaced, not retried.
- The guide does not document a 403 or a 429 for exchange. The crate treats them the same way as
  on refresh, because the same endpoint and credentials are involved; the live check
  (ADR-031) is where a difference would show.

## Decision

1. **No redirects, HTTPS only.** `TokenClient::new` builds its HTTP client with
   `redirect::Policy::none()` for every endpoint, so a 3xx is just a response and classifies as
   `Rejected { status }` (never retried). A client built for `TokenEndpoint::Shopify` also sets
   `https_only(true)`; only `TokenEndpoint::Base`, which exists for wiremock tests, may use plain
   HTTP.
2. **Error classes**, by grant and status, unchanged where they were already right:

   | Grant | Status | `TokenError` | Retried | The app answers |
   | --- | --- | --- | --- | --- |
   | exchange | 400 | `InvalidSubjectToken` (stale ID token) | no | 401 and the retry header |
   | refresh | 401 | `Revoked` (dead refresh token) | no | the merchant re-authenticates |
   | either | 403 | `CredentialsRejected` (new) | no | 5xx, and an operator checks `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` |
   | either | 429 | `RateLimited` | yes | 503 |
   | either | 5xx | `Upstream { status }` | yes | 503 |
   | either | timeout or connection failure | `Transport` | yes | 503 |
   | either | any other status | `Rejected { status }` | no | 5xx |

   `CredentialsRejected` is the only new variant. `shopify-auth` already sends every
   non-stale, non-retryable exchange error to `AuthError::Exchange` (answered 500 with an alert)
   and every such refresh error to `RefreshError::Rejected`, so it needed no change. A 401 on
   exchange stays `Rejected`: Shopify's guide does not give it a meaning of its own.
3. **Bodies and secrets stay out of errors and logs.** `TokenError` holds a status code at
   most. The response body is read only for a successful response, and a failure to read it is
   `Decode`.
4. **No shop domain in the client's logs.** The `exchange` and `refresh` spans carry no fields;
   the caller, which holds the tenant and shop ids, logs them. The error event's text is the
   fixed `Display` of `TokenError`.

## Consequences

- Tests in `crates/shopify`: a table of every grant and status pair above; a redirect test that
  checks 301, 302, 307 and 308 reach a second server zero times; a test that a client built for
  Shopify refuses `http`; and `log_hygiene`, which captures every span and event at trace level
  for success and failure paths and asserts the log holds no shop domain, token, secret or
  response body. Each was run against the previous behaviour and failed there.
- A wrong `SHOPIFY_API_SECRET` now surfaces as `CredentialsRejected` in `refresh` and
  `exchange` errors instead of a bare `Rejected { status: 403 }`.
- If Shopify answers a bad client secret with a 400 or 401 instead of a 403, exchange would
  report a stale token and refresh would report a dead one. The live dev-store check (ADR-031)
  proves the stale-token mapping on the real endpoint; a bad-credentials probe would need a
  second, deliberately wrong secret and is not part of R0.

## Rejected alternatives

- Classifying by the OAuth `error` code in the body: the documentation fixes the meaning by
  status, and reading bodies is the risk this ADR removes.
- Following redirects to Shopify's own hosts only: the token endpoint has no documented
  redirect, so any redirect is unexpected.
- Retrying a 403 once: the documentation says the answer does not change with waiting.
