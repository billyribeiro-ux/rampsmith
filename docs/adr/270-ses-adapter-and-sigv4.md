# ADR-270: The Amazon SES adapter, a small SigV4 signer and the error mapping

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 email sender (`packages/email`)
- Refines: ADR-194; PLAN §6, §10

## Context

ADR-194 puts `email.send` in the engine and leaves the SES client open. The engine needs one
call, `SendEmail` of the SES v2 API, with a signed JSON body.

## Decision

1. **No SDK.** `packages/email/src/sigv4.ts` signs the one request shape we send (POST, no query
   string). `@aws-sdk/client-sesv2` 3.1156.0 (Apache-2.0, checked on the registry on 2026-10-22) would add
   nine direct dependencies and their tree to the process that also drives Chromium, for one
   endpoint. The signer is 90 lines and is checked against AWS's published test-suite vector
   (`get-vanilla`) and against botocore 1.43.118's `SigV4Auth` on the real request shape
   (`docs/evidence/email-sender.md`). A mismatch in either fails the build.
2. **API facts**, from the SES v2 service model (botocore `service-2.json`) and the AWS API
   reference: `POST /v2/email/outbound-emails`, signing name `ses`, answer `{MessageId}`;
   `Content.Simple` with `Subject`, `Body.Text`, `Body.Html` and `Headers`; per-message
   `ConfigurationOverrides.Tracking` with open and click tracking `DISABLED`. The subject must be
   7-bit ASCII, so other characters become RFC 2047 encoded-words; header names and values are
   checked against the documented patterns before the call.
3. **Error mapping** (type from `x-amzn-ErrorType`): throttling, quota, paused sending, an unverified
   sender, rejected credentials (401/403), 5xx and network faults **defer** through the queue;
   an account suspension, a rejected message, a bad request and a missing resource are
   **permanent**. `Retry-After` is honoured up to one hour. Error text never carries AWS's message,
   which can quote the recipient.
4. SES has **no idempotency token**. Sending is at least once; ADR-271 records the ledger that makes a
   repeated job a no-op.

## Evidence limits

- `docs.aws.amazon.com/ses/latest/dg/send-email-concepts-email-format.html` was not reachable from the
  build environment, so whether DKIM signs `List-Unsubscribe` is **unverified**. It is a live check in
  LAUNCH.md section E (read the `h=` list of a delivered message).
- Nothing was sent to real SES; the fake endpoint verifies the signature independently.

## Rejected alternatives

- `@aws-sdk/client-sesv2`: the dependency weight above, with no feature we use.
- Sending from ctl: ctl holds Shopify tokens and master keys; SES keys there widen its blast radius,
  and the templates are TypeScript (ADR-194 stands; the SES variables move to the engine in
  `infra/railway/railway.py`).
