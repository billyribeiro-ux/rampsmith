# ADR-088: Webhook subscriptions are declared in `shopify.app.toml`

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-080, ADR-182
- Fixes: re-audit of the webhook and redaction code, gap "no webhook subscriptions exist"

## Context

The listener (ADR-080), the worker and the compliance handlers were built, but nothing
subscribed the app to any topic: `shopify.app.toml` said "Subscriptions arrive with the webhook
intake (R1)" and no code calls `webhookSubscriptionCreate`. Shopify would never have called the
listener, so an uninstall, `shop/redact` and the two customer topics, which Shopify requires of
every public app, would have gone unanswered.

shopify.dev is blocked from the build environment, so the schema was read from Shopify's own
packages on registry.npmjs.org on 22 Oct 2026:

- `@shopify/cli` 4.9.4 (`latest`; the version the repository pins in
  `infra/railway/tools/shopify-cli`), file `dist/chunk-Y743UVBS.js`: the app-config webhooks
  module. `[webhooks]` has `api_version` (string, required), an optional `privacy_compliance`
  table and `subscriptions`, an array of tables with `topics` (string array), `compliance_topics`
  (enum `customers/redact`, `customers/data_request`, `shop/redact`), `uri`, `filter`,
  `include_fields`, `payload_query` and `name`. `uri` is "a relative path starting with a slash,
  an HTTPS URL", `pubsub://`, an EventBridge ARN or `kafka://`.
- `@shopify/app` 3.58.2 (the last standalone release; the code now ships inside `@shopify/cli`),
  `dist/cli/models/extensions/specifications/validation/app_config_webhook.js`: the rules the
  CLI enforces. A subscription needs `topics` or `compliance_topics`; one compliance topic may
  appear in only one subscription; `topic + sub_topic + uri` must be unique; and "The
  privacy_compliance section can't be used if there are subscriptions including
  compliance_topics". `types/app_config_webhook.d.ts` has the same keys.

## Decision

1. `shopify.app.toml` declares two subscriptions, both to
   `https://<webhook host>/webhooks/shopify`, the only path the listener serves (ADR-182):
   `topics = ["app/uninstalled", "shop/update"]` and `compliance_topics =
   ["customers/data_request", "customers/redact", "shop/redact"]`. These are exactly the topics
   `ACCEPTED_TOPICS` in `crates/api/src/webhooks.rs` stores. The legacy `[webhooks.privacy_compliance]`
   table is not used. `api_version` stays `2026-10`.
2. The URI is absolute. A relative path would resolve against `application_url`, which is the
   `web` service's host, while the webhook host is a separate domain that reaches only the api's
   webhook listener (ADR-182). `hooks.rampsmith.invalid` is a placeholder in the committed file,
   like `application_url`; the founder sets it to `RAMPSMITH_WEBHOOK_HOST` (LAUNCH.md C row 10).
3. `infra/railway/tests/test_shopify_app_config.py` parses every `shopify.app*.toml` and asserts
   the version, the topic lists, HTTPS, the listener path, a single host, no duplicate topic and
   uri pair, and no subscription for a topic the listener drops. `release.yml` runs it on any pull
   request that touches those files. `deploy.yml` runs it again, with `RAMPSMITH_WEBHOOK_HOST`
   set, against `shopify.app.<environment>.toml` before `shopify app deploy`, because
   `shopify app config link` writes that file without subscriptions and the host must match the
   environment.
4. Delivery to a development store is a live check (LAUNCH.md section E, "Webhook subscriptions
   deliver").

## Consequences

- After `shopify app config link`, the founder copies the `[[webhooks.subscriptions]]` tables into
  each `shopify.app.<environment>.toml` and sets the host; the deploy refuses otherwise.
- App-specific subscriptions in the app config are managed by `shopify app deploy`, so there is no
  code that creates or repairs subscriptions at runtime. If Shopify removes one (19 consecutive
  failed retries), `docs/runbooks/webhook-backlog.md` step 5 redeploys the config.

## Rejected alternatives

- `webhookSubscriptionCreate` at install: the config file is declarative, reviewed and tested; a
  runtime call is none of those, and Shopify's documentation recommends the file.
- The legacy `privacy_compliance` URLs: three URLs for one path, and incompatible with
  `compliance_topics`.
- A relative `uri`: wrong host (see Decision 2).
