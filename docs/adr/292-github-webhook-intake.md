# ADR-292: GitHub deliveries are stored once, and state is read from the API

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-080, ADR-126, integration audit finding M1

## Context

GitHub signs the raw body of a delivery with the App's webhook secret
(`X-Hub-Signature-256`). The delivery id (`X-GitHub-Delivery`) and the event name
(`X-GitHub-Event`) are not covered by the signature, so a captured body can be replayed under a new
id or a different event name. A webhook body is also a statement by whoever signed it at the
time: an installation that was suspended and resumed again within a minute would leave an
`installation.suspend` body behind that, believed later, disables a working installation.

## Decision

`POST /webhooks/github` on the webhook listener follows the Shopify route (ADR-080): a permit from
a large pool for connections that have proved nothing; the signature header must look like
`sha256=<64 hex>` before the body is read; the body is read under a one-second deadline up to
1 MiB (413 above it); the HMAC is checked in constant time against the current and, during a
rotation, the previous secret; only then a permit of the small pool that protects the database.

Then: the delivery id and event name must be well formed, the content type must be
`application/json`, the body must parse as the documented payload of its event, and the event must
be one of `installation`, `installation_repositories`, `pull_request`, `push` (others, `ping`
included, are acknowledged and dropped). The installation it names must be linked to a store
(`app_github_installation`, a security-definer lookup that exists because the tenant is not known
yet); otherwise it is acknowledged and dropped.

The delivery is stored once per tenant under **both** its delivery id and the SHA-256 of its body
(`github_events`, two unique indexes), and `github.process_event` is enqueued in the same
transaction. A repeat under the same id is GitHub's retry; the same body under a new id is a
replay; both are acknowledged and not processed again.

`ctl` processes the stored copy. A webhook only says that something changed: for installation
events it enqueues `github.sync_installation`, which reads `GET /app/installations/{id}` and
`GET /installation/repositories` with the App's credentials and makes the tables match. Nothing
in a body is written to a table as a fact about the installation. A sweep
(`github_events_sweep`, leader duty) re-queues deliveries whose job vanished, raises the
`github_event_stuck` alert at 24 hours, and deletes processed deliveries after 30 days.

## Consequences

A forged, replayed or relabelled delivery costs at most one extra API read. Pull request and push
events are matched to the pull requests Rampsmith opened by repository id and number (ADR-294)
when the patch pipeline lands.

Tests: `crates/api/tests/github_webhook.rs`, `crates/ctl/tests/github.rs`,
`crates/db/tests/github.rs`.
