# ADR-126: GitHub webhook verification and parsing

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

PLAN §18: forged or replayed webhooks are stopped by constant-time HMAC verification and
deduplication on the provider's event id; payloads are processed only from the stored copy;
webhook parsers get property tests. PLAN §15 lists `installation`, `installation_repositories`,
`pull_request` and `push`. The `api` route and the deduplication table belong to other owners.

Checked on docs.github.com on 2026-10-17:

- [Validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries):
  `X-Hub-Signature-256` is `sha256=` and the hex HMAC-SHA256 of the payload under the webhook
  secret; "Never use a plain `==` operator"; test vector secret `It's a Secret to Everybody`,
  payload `Hello, World!`, signature `757107ea…3e17`; `X-Hub-Signature` (SHA-1) is legacy.
- [Events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):
  `X-GitHub-Event` names the event, `X-GitHub-Delivery` is a GUID per delivery; payloads are
  capped at 25 MB; `installation` and `installation_repositories` reach every App by default;
  `push` has `ref`, `before`, `after`, `created`, `deleted`, `forced` and up to 2048 `commits`;
  `pull_request` has 22 actions, `number` and `pull_request`; `installation` is present when the
  event is sent to an App; `repository` and `sender` are common fields.
- [Get an installation](https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app):
  `account` is a user (`login`, `id`, `type`) or an enterprise (`id`, `name`, `slug`);
  `repository_selection` is `all` or `selected`.

## Decision

1. `WebhookVerifier::new(secret)` holds the secret as `SecretString`; `with_previous` adds the
   old secret for a rotation's overlap window. Every configured secret is checked on every
   delivery (no early exit), each with `hmac`'s `verify_slice`, which compares with `subtle`'s
   constant-time equality. Empty secrets are refused.
2. `verify_and_parse(headers, raw_body)` order: body over 25 MB → `PayloadTooLarge`; signature
   header missing → `MissingHeader`; not `sha256=` plus 64 hex digits → `InvalidHeader`; no match
   → `SignatureMismatch`. Only then are the delivery id (1 to 64 letters, digits, hyphens), the
   event name (1 to 64 lowercase letters or `_`) and, when present, `Content-Type`
   (`application/json`) checked, and the body parsed.
3. Payloads decode into structs with only the fields Rampsmith uses; unknown fields are
   ignored and unknown actions parse as `Other`, so a GitHub addition never breaks intake.
   `installation` → id, account (login and type optional for enterprises), repository selection,
   suspension, repositories; `installation_repositories` → installation id, selection, added and
   removed repositories; `pull_request` → action, number, id, state, merged, head and base ref and
   SHA, repository id and full name, installation id; `push` → ref, before, after, created,
   deleted, forced, repository, installation, and each commit's added, removed and modified paths
   (`PushEvent::changed_paths` for the after-merge job, PLAN §15). Other events, such as `ping`,
   return `Event::Other { name }` so the route can acknowledge them.
4. The `Delivery` carries the `DeliveryId` for the caller to deduplicate on and to store with
   the raw body; storage is not in this crate.
5. Errors never contain the body, the secret or the signature; decoding errors keep only
   category and position.

## Consequences

- Property tests (proptest 1.12.0) prove: a correct signature always verifies; any single-byte
  change to the body or any hex digit of the signature fails; another secret fails; random bodies,
  random header bytes and random JSON shapes under a valid signature never panic.
- The docs page renders only the first action of `installation` and
  `installation_repositories`; the other actions (`deleted`, `suspend`, `unsuspend`,
  `new_permissions_accepted`, `removed`) are modelled and anything else parses as `Other`.

## Rejected alternatives

- Parsing before verifying: lets unauthenticated input reach serde.
- Strict payload structs that reject unknown fields: GitHub adds fields without notice.
- Verifying `X-Hub-Signature` (SHA-1): legacy, and weaker.
