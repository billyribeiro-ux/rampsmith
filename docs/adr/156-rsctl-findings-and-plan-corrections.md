# ADR-156: Findings from building `rsctl` that change the plan, LAUNCH.md and the founder guide

- Status: Accepted
- Date: 2026-10-19

## Context

CLAUDE.md: when documentation or code disagrees with PLAN.md, write an ADR and correct the plan.
This stream may not edit PLAN.md, LAUNCH.md, `docs/FOUNDER_SETUP.md` or other streams' code, so
each correction below is stated here with the exact edit, and carried to the integrator in
`docs/evidence/ws-6-rsctl.md` ("Integration notes"). `rsctl` itself follows LAUNCH.md section C as
written, and a drift test (`tests/doctor/registry.rs`) fails the day the table and the code
disagree, so each edit below that changes a variable name must change `crates/rsctl/src/vars.rs`
in the same pull request.

## Decision

Nothing here changes how `rsctl` behaves today. These are the discrepancies found, with the
decision each one needs.

### Plan correction

1. **PLAN §7, row `aws-sdk-s3`**: append "(not used by `rsctl`, which signs its own four requests:
   ADR-154)". The row otherwise stands for the product's R2 writer.
2. **LAUNCH.md section C, row 1, and FOUNDER_SETUP**: they name `SHOPIFY_API_KEY` and
   `SHOPIFY_API_SECRET`. `crates/api`, `crates/ctl`, `apps/web` and `.env.example` read
   `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. A founder who follows the guide sets
   variables the services do not read. One name must win. Recommended: the code's names, which
   match the Dev Dashboard's "Client ID" and "Client secret" wording and `shopify.app.toml`'s
   `client_id`. The edit is the rows in LAUNCH.md and FOUNDER_SETUP plus the two names in
   `Var::name` in `crates/rsctl/src/vars.rs` (and the messages that quote them); the drift test
   then passes with the new table.
3. **FOUNDER_SETUP, row 12**: the `ws/launch-docs` draft says `TOKEN_MASTER_KEY`; LAUNCH.md and the
   code say `RAMPSMITH_MASTER_KEYS` (a ring, not one key).
4. **FOUNDER_SETUP, SES IAM policy**: the "send only" policy allows `ses:SendEmail` and
   `ses:SendRawEmail`. `rsctl doctor` also needs `ses:GetAccount` and `ses:GetEmailIdentity` to read
   the sandbox status and the identity's verification (ADR-152). Add both read actions, scoped to
   the account and the identity. Without them the row 7 probe fails with a 403 that says so.
5. **LAUNCH.md section C, row 10**: it lists `CLOUDFLARE_API_TOKEN` and no domain variable, so
   `doctor` cannot pick the Rampsmith zone from the token's zones. If a domain variable is added
   (for example `RAMPSMITH_DOMAIN`), the probe can check that exact zone and its DNS records.
6. **LAUNCH.md section C, row 7**: stream WS-10 (`ws/email`, ADR-191) adds `EMAIL_POSTAL_ADDRESS`
   and an optional `EMAIL_TEST_RECIPIENT`. When that lands, the drift test fails until
   `Var::EmailPostalAddress` (and, if wanted, a presence check) is added to `vars.rs`.
7. **LAUNCH.md section C, row 2, `SHOPIFY_APP_GID`**: it is documented as `gid://shopify/App/<id>`
   (ADR-131). Shopify's Partner API reference for `app(id)` shows `gid://partners/App/<id>`. The
   probe sends the configured form and, on an error, the other form, so either works; the first
   live run says which Shopify accepts, and ADR-131 should then say so.
8. **FOUNDER_SETUP statements about `rsctl doctor`** (the `ws/launch-docs` draft says it is "not
   built yet" and describes checks it "will" run). What exists now: no mail is sent (row 7 reads the
   SES account and identity); no DNS or TLS check of the app, site or webhook hosts is made (row 10
   reads zones and DNS records); the Partner API probe runs `app(id)`, not the active-subscription
   query, which belongs to the billing code; the storefront password is not checked (row 3 checks
   that the password page answers). The rows with a manual test remain in LAUNCH.md section E.

### Not decided here

- The Railway workspace-token probe (row 8) reads `project(id)` for the project that
  `RAILWAY_TOKEN` names, because the founder inputs hold no workspace id and Railway documents the
  workspace token only with `workspace(workspaceId:)`. If a founder-input row adds the workspace
  id, the probe should read the workspace instead.
- Whether to add a job that walks stored ciphertexts and calls `KeyRing::rewrap` (ADR-153, step 4).
  `crates/crypto` has the function and `rsctl keys rotate` prepares the ring, but nothing calls
  `rewrap` yet, so a rotated ring keeps its old keys indefinitely.

## Consequences

- If the edits are not made, the drift test keeps `rsctl` aligned with LAUNCH.md while the services
  read other names. Items 2 and 3 are the ones that would stop a deployment.
- The `security-auditor` review at effort `max` is owed for this stream before it merges
  (CLAUDE.md: any change to auth, tokens, encryption or `egress`), covering `secret.rs`, `http.rs`,
  `sigv4.rs`, `keys.rs`, the panic hook and the redaction tests.

## Rejected alternatives

- Reading both `SHOPIFY_CLIENT_ID` and `SHOPIFY_API_KEY` in `rsctl`: it hides the mismatch the
  founder will hit when the services start.
- Editing LAUNCH.md, FOUNDER_SETUP or PLAN.md from this stream: those files belong to other owners.
