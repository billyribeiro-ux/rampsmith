# Webhook backlog

| | |
| --- | --- |
| Answers | The SLO "Webhooks acknowledged" (99.9% within 1 s over 30 days) and the page "Webhook signature failures above baseline" (PLAN §21); the ticket "Oldest ready scan job older than 10 minutes" when webhook-started scans queue behind a backlog |
| Severity | SEV2: webhooks failing or processing far behind. SEV1 if a compliance topic (`customers/data_request`, `customers/redact`, `shop/redact`) or `app/uninstalled` is being lost |
| Use it when | Webhook intake errors or slows; the `webhook.process` queue grows; signature failures rise; a store's changes do not show in the app; Shopify or GitHub reports failed deliveries |
| Decisions behind it | ADR-178 (this runbook and what it assumes), ADR-177 (the GitHub secret), ADR-182 (the webhook host serves only `/webhooks/*`) |
| Verified | 2026-10-19 against Shopify's and GitHub's documentation (cited in ADR-178) and the queue code. **Most of the webhook system is not built**, so most steps below cannot run yet. The table says which; nothing here was run against a live webhook |

## What exists, and what does not

| Piece | State |
| --- | --- |
| The queue, `jobs-depth.sql`, `jobs-dead.sql`, dead-letter triage | Built and tested ([dead-letter triage](dead-letter-triage.md)) |
| Shopify webhook HMAC code (`crates/shopify`), GitHub `WebhookVerifier` (`ws/github-app`) | Library code only |
| The `/webhooks/shopify` and `/webhooks/github` routes, the second listener on `WEBHOOK_BIND_ADDR`, the `webhook_events` table with its unique event id, the `webhook.process` handler | **Not built** (PLAN §10, §14). No branch has them (checked 19 Oct 2026) |
| Webhook subscriptions | **Not built**: `shopify.app.toml` says "Subscriptions arrive with the webhook intake (R1)" |
| Counters for received, acknowledged, signature-failed webhooks (the signals behind the SLO and the page) | **Not built** |
| A reconciliation job that fetches what webhooks missed | **Not built**; Shopify tells apps to build one |
| `rsctl webhooks …` (list, replay) | **Not built**; nothing replays a stored event |

This runbook is the plan for operating the intake once it exists. Steps that need an unbuilt piece say so. What is built today is the queue half (steps 3 and 5).

## What the providers do (so you know how long a gap can be)

- **Shopify** (shopify.dev, read 19 Oct 2026): a delivery that is not answered fast is retried "a total of 8 times over 4 hours using an exponential backoff schedule"; "A webhook is removed when 19 consecutive retried delivery attempts fail"; "Shopify has a one-second connection timeout and a five-second timeout for the entire request". `X-Shopify-Webhook-Id` identifies one delivery (deduplicate on it); `X-Shopify-Event-Id` ties together deliveries that came from the same merchant action, across subscriptions. Shopify's advice: "build a reconciliation job that periodically retrieves data you might have missed using Shopify APIs".
- **GitHub** (docs): a delivery that fails or takes longer than 10 seconds is recorded as failed and is **not** redelivered automatically; you can redeliver deliveries from the past 3 days, in the web interface or through `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{delivery_id}/attempts`.

So an intake outage under about 4 hours heals itself for Shopify once intake answers again. Past that, or after a subscription is removed, events are gone until reconciliation. GitHub events are never retried for you.

## 1. Which of four problems is it?

Open the ticket with the time and the symptom. Then:

| Symptom | Problem | Go to |
| --- | --- | --- |
| Providers report timeouts or 5xx; the SLO is burning; no `webhook.process` jobs arrive | Intake is not answering | Step 2 |
| Many `401` answers; signature failures above baseline | The secret does not match | Step 4 |
| `webhook.process` jobs arrive but `ready` grows and its oldest age rises | Processing is behind | Step 3 |
| The app misses changes after an outage; Shopify's delivery report shows failures or a missing subscription | Events were lost | Step 5 |

## 2. Intake is not answering (not built)

When the listener exists:

1. From any machine: `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<webhook host>/webhooks/shopify` with **no body and no signature**. A healthy intake answers `401` (an invalid signature returns 401, PLAN §14), not `5xx`, a timeout, or a Cloudflare error page. Never send a real payload.
2. If it does not: Cloudflare (DNS and proxy for the webhook host), then Railway: `railway deployment list --service api --environment production`, `railway logs --service api --environment production --since 30m --filter "@level:error"`.
3. The webhook host must serve only `/webhooks/*`: the deploy's `ensure_network.py` fails any other exposure (ADR-182). If a deploy changed the exposure, the deploy log says so.
4. Roll back a bad release with `deploy.yml` by hand from `main` and the previous digests (ADR-185). Migrations are never rolled back.
5. Note the **start and end time of the outage** in the ticket: it decides whether Shopify's own retries cover it (under 4 hours) or step 5 is needed.

## 3. Processing is behind (queue half is built)

```sh
railway link          # once
railway connect postgres --environment production --ssh
```

```text
\i docs/runbooks/sql/jobs-depth.sql
\set queue 'webhook.%'
\i docs/runbooks/sql/jobs-dead.sql
```

Read the `webhook.process` rows: `ready` count, `oldest_ready_seconds`, `running`, `dead`.

- **`ready` high, `running` zero or flat:** workers are not claiming. `railway deployment list --service ctl --environment production`; `railway logs --service ctl --environment production --since 30m`. A crash loop or a missing variable shows at boot. `railway redeploy --service ctl --environment production --yes` restarts the latest deployment; fix the cause before relying on it.
- **`running` high and not finishing:** a slow dependency (database, Shopify). The lease reaper returns stalled jobs after their leases expire (10-second reaper).
- **`dead` rising:** [dead-letter triage](dead-letter-triage.md). A webhook job that dies with `payload_invalid` is a parser or version problem (an API version change: [version upgrade](shopify-api-version-upgrade.md)).

Because the stored copy of each event is what is processed (PLAN §18), draining the queue is safe and in order of priority and `run_at`; no replay from logs is ever needed or allowed.

## 4. Signature failures (not built: the counter)

1. Shopify deliveries are signed with the app's client secret. A client secret changed in the Partner Dashboard but not in Railway (`SHOPIFY_API_SECRET`, shared variable, services `api` and `ctl`) makes every delivery fail. `rsctl doctor --row 1` with the production values proves the secret works against Shopify; compare with what Railway holds by deploying the vault's value (a sealed variable cannot be read back).
2. GitHub deliveries are signed with the App's webhook secret (`GITHUB_APP_WEBHOOK_SECRET`, service `api`): see [rotate the GitHub App key](rotate-github-app-key.md), Part 2, for the sequence and for redelivering what failed.
3. A rate of failures that is neither of these is a probe or an attack on the public endpoint. Do not loosen verification; do not respond differently to unsigned requests. Note the source in the ticket and go to [incident response](incident-response-and-postmortem.md) if it sustains.

## 5. Events were lost (not built: reconciliation)

1. Decide the gap: from the first failed delivery to the first success, from the ticket's outage times and the providers' own reports (Shopify's webhook delivery metrics report for apps built through the Partner Dashboard or CLI; GitHub's Recent deliveries under the App's Advanced settings).
2. **Shopify, gap under 4 hours:** nothing to do once intake answers; retries land by themselves. Check `jobs-depth.sql` drains.
3. **Shopify, longer, or the subscription was removed:** the events are gone. Reconcile by hand through the Admin API for the topics Rampsmith subscribes to (`products/create`, `products/update`, `themes/publish`, `themes/create`, `shop/update`, `app/uninstalled`; PLAN §14): read what changed since the start of the gap and enqueue the same work a webhook would have. No tool does this yet; write the findings in the ticket and ask the founder before running any bulk change. A missed `app/uninstalled` shows itself when that shop's token calls are rejected (`RefreshOutcome::Revoked`, `shopify.token_revoked` in `audit_log`).
4. **Re-create a removed subscription:** subscriptions are declared in `shopify.app.toml`, and `shopify app deploy` (the `shopify` job of `deploy.yml`, with a second approval on production) pushes them. Confirm in Shopify's delivery report that the subscription is back.
5. **Compliance topics** (`customers/data_request`, `customers/redact`, `shop/redact`): a missed one is a deadline problem (30 days, PLAN §19), not just a freshness problem. Ask Shopify support whether it can resend, say which shops and dates in the ticket, and have the attorney review the position before anything is promised to a merchant. Whether Shopify resends mandatory webhooks after the retries are exhausted is not stated on the pages read.
6. **GitHub:** web interface: Settings > Developer settings > GitHub Apps > the App > Edit > Advanced > Recent deliveries; open each failed delivery in the gap and click Redeliver. Only the past 3 days are available: beyond that the events are gone and the affected repositories re-sync when the next event arrives (not built).

## Verify (done means)

- Intake answers `401` to an unsigned POST and `200` to the providers' real deliveries; the provider's delivery report shows no new failures.
- `jobs-depth.sql`: `webhook.process` has no `dead` rows without a ticket line and `oldest_ready_seconds` is back near zero.
- The reconciliation or redelivery covers the gap, or the ticket states what was lost.
- The SLO impact (minutes of failed acknowledgements) is in the ticket for the postmortem.

## Rollback

Steps 2 and 3 change nothing a restart cannot undo. A release rollback is `deploy.yml` with the previous digests. Redelivery is idempotent by design (deduplication on the provider's delivery id; PLAN §14 and ADR-178's Plan correction), so a delivery processed twice does no harm once the intake exists.

## Escalation

Shopify (<https://shopifystatus.com>, Partner support) for delivery problems on their side; GitHub's status page and support for the App's deliveries; Cloudflare and Railway status for the path. Any compliance-topic loss or sustained forged traffic: [incident response](incident-response-and-postmortem.md), SEV1, founder.
