# ADR-152: `rsctl doctor` probes and the vendor documentation each relies on

- Status: Accepted
- Date: 2026-10-19

## Context

CLAUDE.md requires every vendor detail to be checked in official documentation at implementation
time, with the pages cited. LAUNCH.md section C lists twelve founder inputs; the "How the code
proves it works" column names a live read for most of them. `curl` from the build sandbox
reaches only `api.anthropic.com`, so every other page below was read through the search and
fetch tools on 2026-10-19, and the request shapes are exercised against fakes built from the
documented responses (ADR-155). The first live run against each vendor is the founder's, as a
Section E row.

Where a published page could not be fetched, its source was read instead: the R2 and Turnstile
pages from the `cloudflare/cloudflare-docs` repository, the OTLP and exporter pages from the
OpenTelemetry specification repository, the AWS SES v2 service description and endpoint table
from `botocore` data, and the GitHub, Cloudflare and Stripe REST references from their OpenAPI
descriptions (`github/rest-api-description`, Cloudflare's `api-schemas`, Stripe's `openapi`).
The URLs below are the published pages those sources produce.

ADR-151 sets the rules every probe follows: it reads only its declared variables, makes the
least-privileged documented call, prints vendor error *codes* only, and never prints a secret.

## Decision

One probe per input, below. "Cannot verify" lists what the vendor documents no way to check
without using the input; those report `SKIP` with `skip_kind` `not_verifiable`, never PASS.

### Row 1: `shopify.app`

- Calls: `POST https://<dev store A>/admin/oauth/access_token`, form body `grant_type=client_credentials`,
  `client_id`, `client_secret`; then `POST /admin/api/2026-10/graphql.json` with
  `X-Shopify-Access-Token` and `{ currentAppInstallation { accessScopes { handle } } }`.
- Why: the client-credentials grant is the only documented call that takes `SHOPIFY_API_KEY` and
  `SHOPIFY_API_SECRET` and proves them. It works only for a store in the app's own organization
  with the app installed, so it needs development store A (row 3); without it the probe reports
  SKIP naming row 3. The 24-hour token it returns is registered with the redactor.
- Pass: the grant answers a token and `currentAppInstallation` answers.
- Docs: <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant>;
  <https://shopify.dev/docs/api/admin-graphql/2026-10/queries/currentAppInstallation>.
- Also seen: the grant's error bodies (`invalid_client`, `app_not_installed`) in
  <https://community.shopify.dev/t/client-credentials-grant-returning-app-not-installed-error-despite-app-being-installed/33287>
  and <https://community.shopify.dev/t/access-token-in-custom-console-app/34925>; the probe prints
  the error code and a hint.

### Row 2: `shopify.partner-api`, `shopify.automation-token`

- Calls: `POST https://partners.shopify.com/<org>/api/2026-10/graphql.json` with
  `X-Shopify-Access-Token` and `query App($id: ID!) { app(id: $id) { id name apiKey } }`.
- Pass: `app` answers; its `apiKey` equals `SHOPIFY_API_KEY` when that is set (so the Partner API
  client and the app belong together).
- App id form: LAUNCH.md and ADR-131 (branch `ws/billing`) use `gid://shopify/App/<id>`; the
  Partner API reference for `app(id)` shows `gid://partners/App/<id>`. The probe sends the
  configured form first and the other form if the first answers an error, so either works
  (ADR-156 records the discrepancy).
- Docs: <https://shopify.dev/docs/api/partner>; <https://shopify.dev/docs/partner-api/getting-started>;
  <https://shopify.dev/docs/api/partner/latest/queries/app>; ADR-131 for the endpoint, version,
  header and four-requests-per-second limit (a throttled reply is reported, not retried).
- Cannot verify: `SHOPIFY_APP_AUTOMATION_TOKEN` is a Shopify CLI credential for
  `shopify app deploy`; <https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens>
  documents no read-only check. `shopify app deploy` in CI is its test.

### Row 3: `shopify.dev-store-a`, `shopify.dev-store-b`

- Calls: `GET https://<shop>/password`.
- Pass: 200, meaning the store exists and has a storefront password page. The domain must be a
  `*.myshopify.com` domain (`shopify::ShopDomain`).
- Docs: <https://shopify.dev/docs/storefronts/themes/architecture/templates/password>.
- Cannot verify: the password itself. Checking it means submitting the storefront login form,
  which is a login attempt on a store, so the probe does not. The dev-store end-to-end suite
  uses the password.

### Row 4: `github.app`

- Calls: `GET https://api.github.com/app` with `Authorization: Bearer <JWT>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`. The JWT is RS256,
  signed with `GITHUB_APP_PRIVATE_KEY`, with `iat` 60 s in the past (clock drift), `exp` 540 s
  in the future (inside the ten-minute limit), and `iss` the client id.
- Pass: the response `id` equals `GITHUB_APP_ID` and its `client_id` equals `GITHUB_APP_CLIENT_ID`.
  A 401 reports the clock skew when the `Date` header shows more than 60 s.
- Docs: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app>
  (claims, RS256, `iss` is the client id, ten-minute maximum, clock drift);
  <https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app> and the `api.github.com`
  OpenAPI description (version 1.1.4, date version 2026-03-10) for the response fields.
- Cannot verify: `GITHUB_APP_WEBHOOK_SECRET`. GitHub masks it when read back; only presence is
  checked.

### Row 5: `anthropic.models`

- Calls: `GET https://api.anthropic.com/v1/models?limit=1000` (and `after_id` while `has_more`)
  with `x-api-key` and `anthropic-version: 2023-06-01`.
- Pass: the key lists models and the three PLAN §13 models (`claude-haiku-5-5`,
  `claude-sonnet-5-5`, `claude-opus-5-5`, with a dated suffix allowed) are among them; a key that
  lists others only fails and names what is missing.
- Docs: <https://platform.claude.com/docs/en/api/models-list>. The 401 fixture is a real response
  recorded from `api.anthropic.com` on 2026-10-19.

### Row 6: `r2.evidence`, `r2.backups`

- Calls: against `https://<account>.r2.cloudflarestorage.com`, path style, region `auto`,
  `SigV4` service `s3` with a signed `x-amz-content-sha256` (ADR-154): `PUT
  /<bucket>/rsctl-doctor/<time>-<nanos>.txt`, `GET` the same key, `DELETE` it.
- Pass: the body read back equals the body written and the delete succeeds. The object is
  deleted even when the read fails.
- Docs: <https://developers.cloudflare.com/r2/api/s3/api/> (supported operations: PutObject,
  GetObject, DeleteObject); <https://developers.cloudflare.com/r2/api/tokens/> (S3 credentials and
  the endpoint form); <https://developers.cloudflare.com/r2/get-started/s3/> (region `auto`);
  <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html>
  and <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html> for the
  signature.
- Cannot verify: the evidence bucket's 90-day lifecycle rule. It is the founder's dashboard step,
  and reading it needs a token broader than the bucket token.

### Row 6: `turnstile.siteverify`

- Calls: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, form `secret` and a
  `response` no widget produced.
- Pass: `error-codes` contains `invalid-input-response` (the secret was accepted and the token
  rejected). `invalid-input-secret` or `missing-input-secret` fails. A `success: true` answer
  fails: the secret is a testing secret. Cloudflare's documented dummy secrets (`1x`, `2x`, `3x`
  followed by zeros and `AA`) fail in `--environment production`.
- Docs: <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/> (endpoint,
  error codes); <https://developers.cloudflare.com/turnstile/troubleshooting/testing/> (dummy keys).
- Cannot verify: `TURNSTILE_SITE_KEY` is public and has no server-side check.

### Row 7: `ses.identity`

- Calls: `GET https://email.<region>.amazonaws.com/v2/email/account`, then
  `GET /v2/email/identities/<id>` for the domain of `EMAIL_FROM`, then for the exact address if
  the domain is not found. `SigV4` service `ses` (ADR-154). No mail is sent.
- Pass: `ProductionAccessEnabled` (out of the sandbox), `SendingEnabled`, and
  `VerifiedForSendingStatus` for the identity.
- Docs: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html>;
  <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html>; the SES v2
  service description (`endpointPrefix` `email`, API version 2019-09-27) for the host.
- Needs IAM: `ses:GetAccount` and `ses:GetEmailIdentity` on top of the send permission
  (ADR-156 records that FOUNDER_SETUP's send-only policy must add them).
- Cannot verify: that mail reaches an inbox. LAUNCH.md row 7 names a test email delivered to the
  founder; that stays a manual Section E step, because `doctor` never sends mail.

### Row 8: `railway.project-token`, `railway.workspace-token`

- Calls: `POST https://backboard.railway.com/graphql/v2`. The project token goes in the
  `Project-Access-Token` header with `query { projectToken { projectId environmentId } }`; the
  probe then asks for `environment(id) { name }` and compares it with `--environment`. The
  optional workspace token goes in `Authorization: Bearer` and reads `project(id) { id name }` for
  the project the project token names.
- Pass: the token answers; the environment name matches when Railway returns it.
- Docs: <https://docs.railway.com/integrations/api> (endpoint, token types and headers);
  <https://docs.railway.com/reference/public-api>;
  <https://docs.railway.com/integrations/api/manage-environments> (the `environment` query).
- Cannot verify: a workspace token's own scope. Railway documents `workspace(workspaceId:)` for it
  and the founder inputs hold no workspace id, so the probe reads the project the project token
  names. That combination is not a documented example; the input is optional and a failure here
  is reported as such (ADR-156).

### Row 9: `otlp.export`

- Calls: `POST <OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces`, `Content-Type: application/x-protobuf`,
  empty body, with `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `name=value`, percent-decoded).
  `OTEL_EXPORTER_OTLP_PROTOCOL`, when set, must be `http/protobuf`.
- Pass: 200. An empty body is a valid `ExportTraceServiceRequest` with no spans, and the OTLP/HTTP
  specification says a server answers it with 200 and an `ExportTraceServiceResponse`, so nothing
  is stored and the call tests the endpoint and the token only.
- Docs: <https://opentelemetry.io/docs/specs/otlp/> (OTLP/HTTP, binary protobuf, empty request);
  <https://opentelemetry.io/docs/specs/otel/protocol/exporter/> (the three variables and the
  header format); <https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/>
  (endpoint `https://otlp-gateway-<zone>.grafana.net/otlp`, Basic authentication with the
  instance id and token, `http/protobuf`).
- Cannot verify: that a trace becomes visible in Grafana; that is the "trace visible end to end"
  check in row 9, done with the deployed services.

### Row 10: `cloudflare.dns` (optional)

- Calls: `GET https://api.cloudflare.com/client/v4/zones?per_page=50`, then
  `GET /client/v4/zones/<id>/dns_records?per_page=1`, bearer token.
- Pass: the token sees at least one zone and can list the DNS records of the first. Nothing is
  created or changed. LAUNCH.md row 10 names no domain variable, so the probe cannot pick the
  Rampsmith zone and reports up to three zone names for the founder to check (ADR-156).
- Docs: <https://developers.cloudflare.com/api/resources/zones/methods/list/>;
  <https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/>
  (read from Cloudflare's OpenAPI description).

### Row 11: `stripe.account` (optional, R3)

- Calls: `GET https://api.stripe.com/v1/account`, bearer secret key.
- Pass: the secret key retrieves its own account. Shape checks (no network): `STRIPE_SECRET_KEY`
  starts `sk_test_`, `sk_live_`, `rk_test_` or `rk_live_`; `STRIPE_PUBLISHABLE_KEY` starts `pk_`
  in the same mode; `STRIPE_WEBHOOK_SECRET` starts `whsec_`.
- Docs: <https://docs.stripe.com/api/accounts/retrieve> (`GET /v1/account` returns the
  authenticated account); <https://docs.stripe.com/api/authentication> (bearer authentication,
  401 on a bad key).
- Cannot verify: the publishable key and the webhook signing secret have no read call; only their
  documented shapes are checked.

### Row 12: `master-keys.round-trip`

- No network. `RAMPSMITH_MASTER_KEYS` is parsed by `crypto::KeyRing::parse`; every key seals and
  opens a probe value; the ring as a whole opens what its active key sealed. Format and tools:
  ADR-021 and ADR-153.

### Row 15: `staging.separate-apps` (only `--environment staging`)

- No network. Compares the staging `SHOPIFY_API_KEY` and `GITHUB_APP_ID` with
  `--production-shopify-api-key` and `--production-github-app-id`; sharing either fails, because
  each app has one set of URLs and one webhook endpoint (LAUNCH.md row 15).

## Consequences

- Every probe's request shape is documented above and tested against a fake that answers with
  the documented response. What the fakes cannot prove is that the vendor still answers that way.
  Section E carries one live row per probe for that.
- The probes ask for the smallest documented read. Three need more than "the token works": Shopify
  needs a development store with the app installed, SES needs two read permissions, and the
  Railway workspace token is read through the project the project token names.
- When a vendor changes a response, the probe fails with a status and a code and no vendor text;
  the fixtures in `tests/fixtures/` show the shape the probe expects.

## Rejected alternatives

- Sending a real email, creating a real DNS record, or pushing a real span to prove rows 7, 10 and
  9: each would leave residue in the founder's account and needs a broader permission.
- Checking the storefront password by submitting the login form: it is a login attempt against a
  store, and Shopify documents no other check.
- Treating "present" as PASS for credentials the vendor cannot check: a PASS must mean exercised.
