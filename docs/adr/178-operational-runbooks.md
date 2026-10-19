# ADR-178: Operational runbooks: dead-letter triage, webhook backlog, Shopify API version upgrade, AI provider outage

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`docs/runbooks/dead-letter-triage.md`, `webhook-backlog.md`,
  `shopify-api-version-upgrade.md`, `ai-provider-outage.md`, `docs/runbooks/sql/`)
- Refines: PLAN §10, §14, §21, §22 ("Runbooks"); ADR-018, ADR-022, ADR-183, ADR-214 and ADR-215
  (the last two on `ws/ai`), ADR-126 (on `ws/github-app`)

## Context

PLAN §22 names four runbooks that depend on the queue, the webhooks, Shopify's API versions and the
AI provider. Most of what they operate is not merged yet, so each must say which commands run
today and which wait for code. Checked on 19 Oct 2026:

**The queue (in the repository).** `jobs` has states `ready`, `running`, `succeeded`, `failed`,
`dead`, `cancelled` (`crates/db/migrations/20261017000003_jobs.sql`). `queue::fail` makes a retryable
failure with attempts left `ready` again after `retry_delay` (5 s doubling to 1 h, with jitter) and
anything else `dead`, with `last_error` holding `code`, `message` and `retryable`;
`queue::reap_expired` returns a job whose lease expired to `ready` or, with no attempts left, to
`dead` with code `lease_expired`; `queue::retry_dead` makes a dead job ready with `attempts = 0`
and its comment says "Operator action through `rsctl jobs retry` only"
(`crates/queue/src/ops.rs`). `rsctl` has `doctor` and `keys` only, so that command is **not built**.
`queue::depth` computes depth and the age of the oldest due job but nothing exports it as a
metric: the exported instruments are `rampsmith.queue.attempts` (by queue and outcome) and
`rampsmith.queue.claim.duration` (`crates/queue/src/worker.rs`). The worker logs `job is dead` with
the job id, queue and attempt. The worker role sees every job and no tenant-owned row
(`workers_see_every_job`, `tenant_isolation`). `ctl` runs only `shopify.token_refresh` and the
leader's reaper (`crates/ctl/src/lib.rs`). The codes it produces: `payload_schema_unknown`,
`payload_invalid`, `tenant_missing` (all permanent), `shopify_unavailable` and `database`
(retryable), `shopify_rejected` and `crypto` (permanent). A successful or fresh refresh enqueues
the next weekly keep-alive; a failed one does not, so a dead refresh job breaks that shop's chain
(`crates/ctl/src/token_refresh.rs`). A refresh answered "revoked" deletes the tokens and is not an
error (`crates/shopify-auth/src/lib.rs`). `audit_log` accepts actor kind `operator`.

**Shopify webhooks**, from shopify.dev (read 19 Oct 2026):
[Verify webhook deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries):
HMAC-SHA256 in `X-Shopify-Hmac-SHA256`; "Use X-Shopify-Webhook-Id to deduplicate individual
deliveries"; "Use X-Shopify-Event-Id to correlate deliveries that originated from the same merchant
action"; "Shopify has a one-second connection timeout and a five-second timeout for the entire
request"; "build a reconciliation job that periodically retrieves data you might have missed using
Shopify APIs".
[Updates to webhook retry mechanism](https://shopify.dev/changelog/updates-to-webhook-retry-mechanism):
"retried a total of 8 times over 4 hours using an exponential backoff schedule".
[Troubleshoot webhooks](https://shopify.dev/docs/apps/build/webhooks/troubleshooting-webhooks):
"A webhook is removed when 19 consecutive retried delivery attempts fail"; a webhook delivery
metrics report exists for apps built through the Partner Dashboard or Shopify CLI. **Not built** in
the repository: the `/webhooks/shopify` route, the `webhook_events` table, the `webhook.process`
handler, subscriptions in `shopify.app.toml` (it says "Subscriptions arrive with the webhook intake
(R1)"), a reconciliation job. The GitHub half is in ADR-177 (no automatic redelivery; three days;
`GET /app/hook/deliveries`).

**Shopify versions**, [About Shopify API versioning](https://shopify.dev/docs/api/usage/versioning):
a new version every three months at 5 pm UTC on the first day of the quarter; each stable version
supported at least 12 months with at least nine months of overlap; a request to an inaccessible
version "falls forward" to the oldest accessible stable version and the response header
`X-Shopify-API-Version` shows the version used (webhooks carry `X-Shopify-Api-Version`); the release
candidate of the next version appears on the day the previous stable one is released; deprecations
are announced through Dev Dashboard alerts, GraphiQL warnings, the developer changelog and the
app's emergency developer contact; an app still on an unsupported resource after a deadline can be
delisted. On the page, 2026-10 is "Latest stable" and 2027-01 "Release candidate". The version is
spelled out in `crates/shopify/src/lib.rs` (`API_VERSION`), `shopify.app.toml` (`[webhooks]
api_version`), the Partner API client (`PARTNER_API_VERSION` in `crates/billing/src/partner_api.rs`
on `ws/billing`, which Shopify versions separately, ADR-131) and `rsctl doctor`'s probes
(`crates/rsctl/src/doctor/partner_api.rs`, `ws/rsctl`). `shopify_shops.api_version` is written at
install and reinstall and read by nothing else in the code.

**AI** (`ws/ai`, ADR-214, ADR-215, `docs/evidence/ws-12-ai.md`): errors carry stable codes
(`ai_unavailable`, `ai_spend_limit`, `ai_auth`, `ai_budget_exhausted`, `ai_output_malformed` and so
on); `ai_unavailable`, `ai_spend_limit` and `ai_auth` are retryable at the job level; the circuit
breaker is per engine process (five consecutive capacity failures open it for 30 s doubling to
10 min; a spend limit or rejected key opens it for an hour) and `pausedUntil()` is how the ai worker
stops claiming `ai.*` jobs. The engine's ai worker, the `BudgetLedger` on PostgreSQL and the
`ai_calls` table are **not built** (the evidence file lists them as work for the engine owner), and
the breaker has no metric of its own yet, so the PLAN §21 ticket "AI circuit breaker open for more
than 15 minutes" has no signal behind it. The evidence file carries a runbook for orphaned batches
(list, cancel, delete through the Messages Batches API).

## Decision

1. **The SQL an operator runs lives in `docs/runbooks/sql/` and is executed by a test.** Six files
   (`jobs-depth.sql`, `jobs-dead.sql`, `jobs-retry-dead.sql`, `jobs-token-state.sql`,
   `master-key-usage.sql`, and `audit-window.sql` for the incident runbook, ADR-179) and
   `infra/restore-drill/tests/runbook-sql.sh`, which migrates a fresh PostgreSQL 18 with the
   repository's migrations, seeds two tenants and jobs in each state, runs every file as the
   superuser and as `rampsmith_ctl`, and checks output and effect (58 checks; it runs in the
   `backup-tests` job on every pull request that touches `docs/runbooks/sql/`). A runbook step that
   nobody ran is a guess.
2. **Least privilege inside break-glass.** The job files begin with `set role rampsmith_worker`, so
   even a superuser connection sees only what `ctl` sees. Three files need the superuser, the
   master-key report, the token state of one shop and the audit window; each refuses any role that row-level security
   applies to, because under RLS the tenant function raises an error and a quieter failure could read
   as "no data under this key".
3. **Triage before retry.** The dead-letter runbook is a table from error code to meaning and action,
   with one rule: a dead job is retried only when its cause is understood and fixed. The table:

   | `last_error.code` | Meaning | Action |
   | --- | --- | --- |
   | `shopify_unavailable`, `database` | Retryable failures that used all 8 attempts | Find the outage (Shopify status, Railway status, database load); retry after recovery |
   | `shopify_rejected` | Shopify refused a refresh in a way that is not "revoked" | Do not retry blindly; read the message; check the app's credentials (`rsctl doctor --row 1`) |
   | `crypto` | A stored value does not open with the ring | Stop. Master-key runbook: a key was dropped or the ring is wrong. Retry only after the ring is right |
   | `payload_schema_unknown`, `payload_invalid`, `tenant_missing` | Version skew or a bug in what enqueued the job | Find the enqueuer; fix forward; retry after the fixed build is live |
   | `lease_expired` | The worker died or stalled | Check `ctl` for restarts and memory; the job is safe to retry |
   | none, or a code not above | Unknown | Escalate; do not retry |

   A dead `shopify.token_refresh` job is urgent beyond its own page: no next keep-alive exists for
   that shop until it succeeds or the shop exchanges a token again (install and exchange enqueue
   the first one, `crates/shopify-auth/src/lib.rs`), and its refresh token ages out after 90 days
   (PLAN §14).
4. **`rsctl jobs retry` is replaced by `jobs-retry-dead.sql` until it exists.** It is the `retry_dead`
   statement for one id, plus an `audit_log` row (`job.retried`, actor kind `operator`) for a
   tenant's job, because PLAN §18 wants cross-tenant operator actions audited. A system job has no
   tenant and cannot be audited; the output says so and the ticket records it. Integration note: the
   `rsctl` owner should build `jobs list`, `jobs retry` and `jobs depth` on `queue::*` and retire
   the files.
5. **The webhook backlog runbook separates four failures** and says which of its steps work today:
   intake not answering (the `api` webhook listener, Cloudflare, `ensure_network.py`); signature
   failures (a secret mismatch: rotate or restore the secret, ADR-177); processing behind (the
   `webhook.process` queue deepens: `jobs-depth.sql`, `ctl`); and lost events (an outage longer than
   Shopify's 4 hours of retries, or a removed subscription). Everything that touches
   `webhook_events` or the route is labelled "not built" with the PLAN section that specifies it.
   Recovery for lost Shopify events is a manual reconciliation through the Admin API for the topics
   affected, because no reconciliation job exists. The runbook forbids the shortcuts that defeat
   the controls: accepting unsigned deliveries, replaying payloads copied from logs.
6. **API version upgrades are a calendar, not a surprise.** The runbook sets two dates per version:
   the day the release candidate appears (read the release notes, run the suite against it in
   staging only) and the quarter's first day when the stable version is released (adopt within the
   overlap, staging before production); and one trigger that ends any calendar: a deprecation
   notice, an `X-Shopify-API-Version` header that differs from the one requested (fall-forward), or
   the synthetic journey failing. The steps list every place the version is spelled and the way to
   find them again (`git grep -n -F -e '"2026-10"' -e '/2026-10/' -- ':!docs'`). The synthetic
   journey of PLAN §21 is **not built**; until it is, the staging end-to-end run on the development
   store (LAUNCH.md C row 3) is the gate.
7. **AI outage: stop spending, keep scanning.** The runbook tells the operator to read the breaker
   state from the engine's logs and the provider's status page, to leave the breaker alone (it
   probes by itself), to confirm scans and data fixes still run, to raise or replace the key and
   spend limit only for `ai_auth` and `ai_spend_limit`, and to clean orphan batches afterwards using
   the evidence file's procedure. Everything keyed to the ai worker is labelled "not built".

## Consequences

- Four runbooks are partly forward-looking. Each has a "Built today / Not built" table at the top, so
  an operator at 3 a.m. does not search for a command that does not exist.
- The first live use of the SQL files is on Railway; the substitute test covers their logic on
  PostgreSQL 18.6, and Section E records the rest (`railway connect postgres --ssh` as the way in).
- The retry arithmetic matters to the runbook: 8 attempts with delays of `e/2` to `e` where `e` is
  5 s doubling spend their budget in 5 to 11 minutes. A Shopify or database outage longer than that
  kills every refresh job it touches, so each outage leaves dead jobs to sweep, and the SLO for token
  refresh (0 shops lost) leans on this runbook. Integration note for the queue owner: a longer budget
  for `shopify.token_refresh` (a larger `max_attempts` at enqueue, or a gentler schedule) would turn
  most outages into delay instead of dead jobs; it is a design change, so it is not made here.
- The files add an audited operator path that only exists in SQL. If the schema of `jobs` or
  `audit_log` changes, the test fails the pull request that changes it.

## Rejected alternatives

- Writing the runbooks only for built features: the missing pieces are exactly the ones an operator
  needs named, and PLAN §22 lists the runbooks for launch.
- Running the retry as the superuser without `set role`: one typo away from a cross-tenant change.
- Retrying all dead jobs of a queue in one statement: hides the one that has a different cause.
- Disabling the circuit breaker during an outage: it is what keeps spend and queue churn bounded.

## Plan correction

PLAN §14, "Webhooks", the paragraph after the table: replace "deduplicates it on Shopify's event id"
with:

> deduplicates it on the `X-Shopify-Webhook-Id` header (Shopify documents it as the per-delivery
> id; `X-Shopify-Event-Id` only correlates deliveries of one merchant action across subscriptions),
> enqueues `webhook.process`, and answers 200 within one second (Shopify's own limits are a
> one-second connection and a five-second request). Shopify retries a failed delivery 8 times over
> 4 hours and removes the subscription after 19 consecutive failed retried attempts, so a
> reconciliation job runs daily to catch missed events and to re-create a removed subscription.

PLAN §18, "Forged or replayed webhooks": "deduplication on the provider's event id" becomes
"deduplication on the provider's delivery id" (`X-Shopify-Webhook-Id`, `X-GitHub-Delivery`).
