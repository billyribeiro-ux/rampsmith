# ADR-031: Shopify credential names and the R0 live dev-store check

- Status: Accepted
- Date: 2026-10-19

## Context

**Names (audit L13).** The code read `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, while
LAUNCH.md section C row 1 and `docs/FOUNDER_SETUP.md` tell the founder to set `SHOPIFY_API_KEY`
and `SHOPIFY_API_SECRET`, the names Shopify CLI uses. A founder who followed the checklist would
have started an `api` that stopped at boot with "SHOPIFY_CLIENT_ID must be set".

**Live check.** R0 step 7 (Shopify authentication) is built and tested against a mock of
Shopify's token endpoint (ADR-022). LAUNCH.md section E says a check that needs a founder input
counts only when three things hold: a substitute test passes now, a live test runs whenever the
input is present and otherwise skips with a notice naming the input, and the check has a row in
section E. The inputs here are LAUNCH.md section C row 1 (the app's key and secret) and row 3
(a development store).

## Decision

1. **Rename.** The variables are `SHOPIFY_API_KEY` (the app's client id, public) and
   `SHOPIFY_API_SECRET` (the client secret) everywhere they are read or set: `crates/api` and
   `crates/ctl` configuration and their tests, `apps/web/src/env.ts` (where the public variable
   is rendered into the `shopify-api-key` meta tag), the Playwright servers,
   `.env.example`, `infra/smoke/`, and the dev-store runbook. The Rust structs keep the field
   names `shopify_client_id` and `shopify_client_secret`: they are OAuth vocabulary and the
   crate's own parameter names. `git grep -n SHOPIFY_CLIENT` returns only historical records: ADR-023,
   the audit record, this ADR and its evidence file.
2. **The probe.** `crates/shopify/tests/live_dev_store.rs`, when `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET` and `SHOPIFY_DEV_STORE_DOMAIN` are all set, builds an ID token for that
   store (`iss` `https://<store>/admin`, `dest` `https://<store>`, `aud` the key, HS256 signed
   with the secret) whose `exp` and `nbf` are more than an hour in the past, sends it through
   `TokenClient::exchange` (`expiring=1`, offline token type) to
   `https://<store>/admin/oauth/access_token`, and asserts the answer classifies as
   `TokenError::InvalidSubjectToken`, the stale-ID-token class, and not as
   `CredentialsRejected`. Shopify answers an expired ID token with 400 and issues nothing
   (ADR-032), so the request cannot install the app or create a token, and the test can run any
   number of times.
3. **What it proves, and what it does not.** It proves live that the store's domain resolves to
   Shopify's token endpoint, that the form the crate sends is accepted as well-formed, that the
   endpoint's answer to an expired token maps to the stale class, and that the answer is not the
   rejected-credentials class. Shopify's documentation does not say in which order it checks
   the client credentials, the token's signature and its expiry, so a 400 here is not by itself
   proof that the secret is right; a wrong secret that surfaces as 403 fails the probe, and one
   that surfaces as another 4xx fails it too. The install and scan suite that LAUNCH.md section E
   lists ("Dev-store end to end") is what proves a full token exchange.
4. **Skipping.** With any of the three missing or empty, the test prints
   `Shopify dev-store live check skipped: needs LAUNCH.md section C rows 1 and 3 (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_DEV_STORE_DOMAIN)`
   to stdout, prefixed with `::notice title=Shopify dev-store live check skipped::` when
   `GITHUB_ACTIONS` is `true`, and returns (a pass). A set but malformed store domain fails the
   test without echoing the value.
5. **The notice must be seen.** nextest hides the output of passing tests. `.config/nextest.toml`
   has an override for `binary(live_dev_store)` with `success-output = "immediate"` in
   `profile.default`; nextest applies `profile.default` overrides to every profile, `ci` included,
   which a local run of `cargo nextest run --profile ci` confirms
   (`docs/evidence/r0-gate-fixes.md`).
6. **The substitute test.** The same file always runs, against wiremock: the probe's token
   verifies with `SessionTokenVerifier` back when it was current and is `Expired` now (so its
   signature, audience, issuer and destination are right and age is its only fault); the exchange
   form matches the documented fields exactly; a 400 passes the probe; 403, 401, 429, 503 and a
   200 each fail it with a message that holds no secret or token; the skip notice text and the
   input handling are asserted. The wiremock exchange and session-token suites in
   `crates/shopify` remain the substitute that LAUNCH.md section E's row names.
7. **Output hygiene.** The test prints nothing but the notice. Failure messages name a class
   and a status, never a secret, an ID token, a response body or the store's domain.

## Consequences

- The row for section E (`Shopify dev store wired (R0)`) is given to the architect in
  `docs/evidence/r0-gate-fixes.md`, because LAUNCH.md is not a builder's file.
- The founder runs one command with three variables (`docs/runbooks/shopify-dev-store.md`,
  section 3) and gets a pass or a message naming the class of Shopify's answer.
- CI shows a notice on every run until the inputs exist as GitHub environment secrets; the
  annotation is the reminder that row 1 and row 3 are open.

## Rejected alternatives

- **The client-credentials grant** (a token minted from the key and secret alone, so no ID token
  to forge). Shopify's guide to Dev Dashboard access tokens
  ([get API access tokens](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens),
  read 2026-10-19) says "The client credentials grant only works when the app and the store belong
  to the same Shopify organization" and "If you're building an app for other merchants to install,
  client credentials won't work". Rampsmith is installed by other merchants, so the grant tests a
  path the product never uses, and it would fail or pass for the wrong reason on a development
  store outside the app's organization.
- **A valid ID token and a real install.** It needs a browser session in the admin to mint a
  current token, installs the app (a side effect), and cannot run unattended. That belongs to the
  end-to-end suite.
- **Skipping silently, or marking the test `#[ignore]`.** CLAUDE.md: a skipped test is not a
  pass, and LAUNCH.md section E requires the notice.
