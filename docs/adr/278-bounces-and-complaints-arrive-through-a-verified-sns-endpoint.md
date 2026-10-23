# ADR-278: Bounces and complaints arrive through a verified SNS endpoint

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email, bounces and complaints (PLAN §5 R1, §16; ADR-191, ADR-272)

## Context

ADR-272 gave each tenant a suppression list that blocks every category for `bounced` and
`complained` addresses, but nothing wrote those reasons. SES reports a permanent bounce or a
complaint by publishing an event to an SNS topic (through a configuration set's event destination);
SNS delivers it to an HTTPS subscriber as a signed JSON document. Sending on to an address that
bounced or complained is what gets an SES account paused, so this is a launch requirement.

## Decision

- **Endpoint.** `POST /webhooks/ses` on the api's public webhook listener (ADR-182), present only
  when `SES_SNS_TOPIC_ARN` is set. Body limit 256 KiB (SNS's message limit), 10 s timeout.
- **Verification, before anything is trusted**, cheapest first, from AWS's "Verifying the signatures
  of Amazon SNS messages" and the reference validator `aws/aws-php-sns-message-validator`:
  1. `x-amz-sns-message-type` equals the body's `Type`;
  2. `TopicArn` equals the configured topic, so a genuine message from some other topic is refused
     (403) before any certificate is fetched;
  3. `SignatureVersion` is `2` (RSA with SHA-256). Version `1` is SHA-1 and is refused;
  4. `SigningCertURL` is `https://sns.<topic region>.amazonaws.com/<path>.pem` with no port, user,
     query or fragment;
  5. the string to sign (`Key\nValue\n` in byte order of the key, over the fields the message type
     covers) verifies under the certificate's public key with `rustls-webpki` (aws-lc-rs, already in
     the tree through `jsonwebtoken`; no new crypto library, and `openssl` stays banned).
  The certificate chain is not validated, as in AWS's own validators: trust comes from fetching it
  over TLS from the regional SNS host. The fetcher follows no redirects, times out at 5 s, caps the
  body at 64 KiB, and a certificate is cached for 6 hours and dropped when a signature fails (AWS
  rotates it).
- **Subscription.** A signed `SubscriptionConfirmation` is followed by a GET of its `SubscribeURL`
  only when that URL is `https` on the topic region's SNS host with `Action=ConfirmSubscription` and
  our `TopicArn`; the founder confirms the subscription by creating it.
- **What is written.** From a `Notification` whose `Message` is an SES event (`eventType` for
  event publishing, `notificationType` for the older identity notifications; both read, unknown
  members ignored): a `Bounce` with `bounceType` `Permanent` writes `bounced`, a `Complaint` writes
  `complained`, for up to 100 recipients, angle brackets stripped. Transient and undetermined
  bounces, deliveries, sends and rejects are acknowledged and dropped (a transient bounce means the
  mailbox may recover).
- **Finding the tenant.** The event carries SES's message id, not ours. `email_deliveries.message_id`
  holds it for sent mail; `email_delivery_tenant(text)` (migration 20261109000002, security definer,
  returns the tenant id only, executable by the api role) maps it, and the write then goes through an
  ordinary tenant transaction and row-level security. An unknown id writes nothing and answers 200
  (another application on the account, or a swept record).
- **Reasons never weaken.** `suppress()` keeps a stronger reason: an `unsubscribed` request after a
  bounce leaves `bounced`; a bounce after an unsubscribe widens it.
- **Answers.** 400 malformed or header mismatch, 401 failed verification, 403 wrong topic, 503 the
  certificate could not be fetched or the database failed (SNS retries), 200 otherwise, including
  redeliveries, which are idempotent.
- **Privacy.** Recipients are hashed by the database; the audit entry `email.suppressed` holds the
  reason and a count, and nothing logs an address.
- **Configuration.** `SES_CONFIGURATION_SET` (mailer) is sent as `ConfigurationSetName` (a
  `SendEmailRequest` member in botocore's `sesv2` 2019-09-27); per-message tracking stays disabled.
  `SES_SNS_TOPIC_ARN` (api) is parsed as `arn:aws:sns:<region>:<12 digits>:<name>`.
  `rsctl doctor --row 7` checks both shapes and that the topic is in the SES region.

## Consequences

- The founder creates an SNS topic (signature version 2 by CLI; AWS documents it for the CLI only),
  a configuration set with a Bounce and Complaint event destination, an HTTPS subscription, and adds
  the set to the sending policy (LAUNCH.md C row 7, FOUNDER_SETUP step 3.9 to 3.12).
- Until the live check in LAUNCH.md section E passes, correctness against a real SNS message rests
  on the documented scheme and on the fake SNS (a generated RSA certificate, real verifier).
- Messages sent before the mailer stored a message id, or swept deliveries, cannot be attributed.

## Rejected alternatives

- **SES feedback by email, or the SES v2 account-level suppression list only.** Does not populate
  our per-tenant list, which is what gates our own sends.
- **Polling an SQS queue.** Needs AWS credentials in the api, a new SDK or a second SigV4 client, and
  another IAM surface. The webhook needs none.
- **Trusting SNS without verifying the signature.** Anyone could then suppress any tenant's customers.
- **Skipping the topic check.** A genuine SNS message from an attacker's own topic would verify.
