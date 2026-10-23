# ADR-276: A mailer service separate from the browser engine

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email audit fixes (audit M1)

## Context

ADR-050 says the SES credentials must not live in the process that holds Chromium. After PR #37 the
`engine` service served `email.send` and carried `SES_*`, so a compromised page render could read
the SES key. The audit rated this medium.

## Decision

- A new Railway service, `mailer`, built from the **engine image** and started with
  `/usr/local/bin/node packages/engine/src/mailer.ts`. It serves only `email.send`, never imports
  the browser, and `packages/engine/test/mailer-isolation.test.ts` fails if its import graph reaches
  browser code.
- It connects with the engine's database login (a plain worker role, `RAMPSMITH_DB_PASSWORD_ENGINE`)
  and holds only `SES_*`, `EMAIL_FROM`, `EMAIL_POSTAL_ADDRESS`, `EMAIL_LINK_KEYS`,
  `EMAIL_ONE_CLICK_ORIGIN`, `APP_ORIGIN` and the telemetry token. It has no egress, Claude, R2 or
  scan-secret variables.
- The `engine` service no longer serves `email.send` and holds no email variable; Chromium is
  launched with a minimal explicit environment (`browserEnv()` allowlist), so a page render cannot
  read the engine's other variables either.
- Railway tests assert each of these; the deploy and release workflows and the image smoke test
  start and check the mailer.
- **Duplicate sends (audit L2).** The ledger claims a row only when no live attempt holds it, and
  the handler checks its queue lease before calling SES, so two attempts at one message cannot both
  send except in the one-statement window ADR-271 records.

## Cost

One more small always-on Railway service. **The founder accepts or declines this at deploy time**;
if declined, the fallback is to run the mailer inside `ctl`, which has no browser, at the cost of
putting SES next to the Shopify and GitHub credentials.

## Rejected alternatives

- Keep email in the engine and rely on the Chromium sandbox: one escape reads the key.
- Run it in `api`: the api faces the internet.
