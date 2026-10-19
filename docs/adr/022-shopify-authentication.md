# ADR-022: Shopify authentication and offline-token lifecycle

- Status: Accepted
- Date: 2026-10-17

## Context

PLAN §14 sets session-token authentication, token exchange with `expiring=1`, envelope
encryption, refresh with compare-and-swap rotation and a weekly keep-alive. The official
documentation, read on 2026-10-17 and recorded in `docs/spikes/S-4-initial-document-token.md`,
differs from the plan in three details, and the documentation wins (PLAN §27):

1. Token exchange must send `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`;
   the plan's list omitted it.
2. The issuer check is "the hostnames of `iss` and `dest` must match"; the plan asked for `iss`
   to equal the host's `/admin`. Rampsmith checks the documented rule.
3. Acquiring a token retires every other refresh token of the app on that store, so exchange
   and refresh must never run concurrently for one shop, not only refreshes among themselves.

## Decision

1. **Crates.** `crates/shopify` holds the protocol only: `ShopDomain`, `SessionTokenVerifier`
   (`jsonwebtoken` 11.1.0 with `aws_lc_rs`, HS256 only, audience pinned, `exp`/`nbf` checked
   against an injected clock with 5 s leeway, `dest` must be `https://<shop>.myshopify.com`)
   and `TokenClient` (`reqwest` 0.13.5 with rustls). Errors never hold response bodies.
2. **Document requests are unauthenticated** (S-4). Data requests carry the ID token as a
   Bearer header; `api` answers every invalid or stale token with `401` and
   `X-Shopify-Retry-Invalid-Session-Request: 1`, including Shopify's `400` on exchange.
3. **Finding the tenant.** A session token names a shop, not a tenant, and row-level security
   hides every shop row until a tenant is set. Migration 5 adds `app_shop_by_domain(text)`, a
   `security definer` function that returns only `(tenant_id, shop_id, status)` for one exact
   domain. `api` calls it only after the token's signature and claims have been verified, so it
   reveals nothing the caller could not already prove.
4. **Serialising token acquisition.** Exchange and refresh for a shop run inside
   `Db::shop_lock`, a transaction-scoped advisory lock keyed on the shop domain, held across
   the HTTP call (bounded by a 10 s timeout). The token row still carries a `version` column
   and every write is a compare-and-swap on it; a lost race re-reads instead of overwriting.
5. **Install.** The first valid session token for an unknown shop exchanges, then creates the
   tenant (`shopify_store`), its verified site (`shopify_install`), the shop and the sealed
   tokens in one tenant transaction. A reinstall reuses the tenant and replaces the tokens.
6. **Refresh.** Before any Admin API call, and in the `shopify.token_refresh` job (`ctl`), an
   access token within 10 minutes of expiry is refreshed. The job also runs at least weekly per
   installed shop so the refresh token never ages out. A `401` on refresh marks the tokens
   revoked (they are deleted) and the merchant re-authenticates on the next app open.
7. **Storage.** Tokens are sealed with `crates/crypto` (ADR-021) under the contexts
   `shopify_tokens/access/<shop id>` and `shopify_tokens/refresh/<shop id>`.

## Consequences

- No route trusts a search parameter for identity.
- A shop's token operations are serialised across all `api` and `ctl` instances by PostgreSQL.
- Live confirmation of S-4 needs a Partner account and a development store (founder action).

## Rejected alternatives

- Reading an `id_token` search parameter on the document request: undocumented for apps
  without a template.
- A bounce page that reloads the document with a token: more moving parts for no gain when the
  shell carries no data.
- Lookup by shop domain through the owner role: would put an RLS-bypassing pool in `api`.
