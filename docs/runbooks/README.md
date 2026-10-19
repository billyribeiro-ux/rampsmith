# Runbooks

What to do when something is wrong, in the order a tired person needs it: which runbook, what exists to
help, what does not exist yet. PLAN §22 lists nine; this directory holds them (ADR-178, ADR-179). The
Shopify development store has its own page, [shopify-dev-store.md](shopify-dev-store.md), which is a
setup guide and not an incident runbook.

Every runbook has the same shape: a header (which alert or SLO it answers, severity, when to use it,
the decisions behind it, **what was verified and how**), a table of what is built and what is not,
numbered steps with the exact commands, how to verify, rollback, and escalation. A step that needs
something that does not exist says **not built**.

## Start here

1. Open a ticket and write the time. Acknowledge the alert; do not mute it.
2. Set the severity with [incident response](incident-response-and-postmortem.md) (SEV1 to SEV4, first
   response 15 minutes, 1 hour, same working day, next working day).
3. Take the runbook below that matches. If none matches, stay in incident response.
4. Connecting to the production database as the superuser is break-glass (PLAN §18): write in the ticket
   when it starts and ends, who and why, and which SQL file you ran.

## The nine runbooks

| Runbook | Use it when |
| --- | --- |
| [Restore from PITR](restore-from-pitr.md) | Data was damaged or deleted and the database still runs; WAL archiving is failing; the database service or volume is gone but the Railway project exists |
| [Restore from the logical backup](restore-from-logical-backup.md) | The Railway project, environment or account is lost; PITR is unavailable or suspect; the data needed is older than the PITR window |
| [Rotate the token master key](rotate-token-master-key.md) | Someone with access to the ring leaves; the ring may have leaked; the yearly rotation |
| [Rotate the GitHub App key](rotate-github-app-key.md) | The App's private key or webhook secret may have leaked, or on schedule |
| [Shopify API version upgrade](shopify-api-version-upgrade.md) | Each quarter (a new stable version at 5 pm UTC on the first day of the quarter); Shopify announces a deprecation; a version is served that was not asked for |
| [Dead-letter triage](dead-letter-triage.md) | A job died; the dead-job page fires; after any outage, to sweep what it killed |
| [Webhook backlog](webhook-backlog.md) | Webhook intake fails or is slow; `webhook.process` grows; signature failures rise; events were missed |
| [AI provider outage](ai-provider-outage.md) | The model API fails or is slow; the breaker is open; a key is rejected; a spend limit stops calls; AI spend jumps |
| [Incident response and postmortem](incident-response-and-postmortem.md) | Anything that is not one of the above; any suspected exposure; any SEV1; every postmortem |

## Alerts and SLOs

PLAN §21 lists twelve alerts (the left column pages, the right opens a ticket) and seven SLOs. The
last column is the honest part: **none of the twelve has a rule in the repository** (no alert or dashboard
definition exists under `infra/`; alerting is a Grafana Cloud account, LAUNCH.md C row 9), and for most the
signal itself is not built. A runbook that says "the alert fires" is a plan, not a fact, until a rule
exists.

| Alert (PLAN §21) | Runbook | Signal today |
| --- | --- | --- |
| Page: any dead job in `shopify.*`, `github.*` or token-refresh queues | [Dead-letter triage](dead-letter-triage.md) | The worker logs the warning `job is dead` with the queue. A log rule can be written now. No metric counts dead jobs, because a job that used up retryable attempts is counted `retryable` and still dies. Only `shopify.token_refresh` exists as a queue |
| Page: webhook signature failures above baseline | [Webhook backlog](webhook-backlog.md), step 4 | **Not built**: no webhook intake and no counter |
| Page: token refresh failures for any shop | [Dead-letter triage](dead-letter-triage.md), step 3 | The metric `rampsmith.queue.attempts` (queue, outcome `retryable` or `permanent`) exists; no rule uses it |
| Page: PostgreSQL WAL archiving failing | [Restore from PITR](restore-from-pitr.md), step 2 | By hand: `railway postgres pitr status`. Nothing exports it to Grafana |
| Page: API 5xx rate above 1% for 5 minutes | [Incident response](incident-response-and-postmortem.md) | Request spans exist (the `tower-http` trace layer in `crates/http-kit`). No 5xx rate metric or rule is defined |
| Page: synthetic run failed twice in a row | [Incident response](incident-response-and-postmortem.md) | **Not built**: no hourly synthetic journey |
| Ticket: oldest ready scan job older than 10 minutes | [Webhook backlog](webhook-backlog.md), step 3; [Dead-letter triage](dead-letter-triage.md) | By hand: `docs/runbooks/sql/jobs-depth.sql` prints `oldest_ready_seconds`. `queue::depth` exists in code and is not exported |
| Ticket: AI circuit breaker open for more than 15 minutes | [AI provider outage](ai-provider-outage.md) | **Not built**: the breaker library has `pausedUntil()`; nothing exports it and the engine's ai worker does not exist |
| Ticket: database connections above 80% of the pool | [Incident response](incident-response-and-postmortem.md) | **Not built**: no pool gauge is exported |
| Ticket: R2 error rate above 1% | [Incident response](incident-response-and-postmortem.md) | **Not built**: no R2 client error metric (the egress proxy exports `rampsmith.egress.requests`, which is a different thing) |
| Ticket: synthetic run failed once | [Incident response](incident-response-and-postmortem.md) | **Not built** (see above) |
| Ticket: daily AI spend above twice its trailing average | [AI provider outage](ai-provider-outage.md), step 5 | **Not built**: no spend metric; the Anthropic Console is the only view |
| Proposed (ADR-179), page: newest complete logical backup older than 72 hours | [Restore from the logical backup](restore-from-logical-backup.md) | `meta.json` timestamps in R2 and the backup workflow's run conclusion. `infra/restore-drill/list-backups.sh` lists them by hand. **No monitor independent of the workflow exists** (founder decision, ADR-179) |
| Proposed (ADR-179), ticket: older than 36 hours; weekly restore drill failed | the same; [restore drill](../../.github/workflows/restore-drill.yml) | The drill's own run fails; the live variant refuses a newest backup older than 48 hours |

| SLO (PLAN §21) | Target | Runbook | Signal today |
| --- | --- | --- | --- |
| Embedded admin page loads that succeed | 99.9% over 30 days | [Incident response](incident-response-and-postmortem.md) | Not built as a measurement |
| Admin LCP, CLS and INP at p75 | 2.5 s, 0.1, 200 ms | [Incident response](incident-response-and-postmortem.md) | Not built: no Web Vitals endpoint in the repository |
| API p95 latency | reads under 300 ms, writes under 800 ms | [Incident response](incident-response-and-postmortem.md) | Request spans only |
| Webhooks acknowledged | 99.9% within 1 s | [Webhook backlog](webhook-backlog.md) | Not built (no intake) |
| Scheduled scans finished inside their window | 99% | [Dead-letter triage](dead-letter-triage.md) | Not built (no scheduler or scan queue yet; `jobs-depth.sql` by hand) |
| Approved data fixes applied within 2 minutes | 99% | [Incident response](incident-response-and-postmortem.md) | Not built |
| Shops losing access because Rampsmith failed to refresh a token | 0 | [Dead-letter triage](dead-letter-triage.md), step 3; [Rotate the master key](rotate-token-master-key.md) | `jobs-token-state.sql` shows days left per shop by hand; the audit action `shopify.token_revoked` records revocations |

The burn-rate rule (above 2× for one hour pages; an exhausted budget freezes feature work) needs the
metrics above before it can be wired.

## The SQL files

Run them with `railway connect postgres --environment <env> --ssh` from a checkout's root (psql 15 or
newer on your machine) and `\i docs/runbooks/sql/<file>`. They run on every pull request against
PostgreSQL 18.6 with the repository migrations
(`infra/restore-drill/tests/runbook-sql.sh`). None prints a payload, a token or a store's name.

| File | Role | What it does |
| --- | --- | --- |
| `jobs-depth.sql` | any login; sets `rampsmith_worker` | Jobs per queue and state, with the age of the oldest ready one |
| `jobs-dead.sql` | any login; sets `rampsmith_worker` | Dead jobs grouped by queue and error code, then the newest; filters `queue`, `code`, `limit` |
| `jobs-retry-dead.sql` | any login; sets `rampsmith_worker` | Makes **one** dead job ready again with a fresh budget, and writes an `audit_log` row naming the operator. Needs `job` and `operator` |
| `jobs-token-state.sql` | superuser only (refuses others) | For one `shopify.token_refresh` job: the shop, the wrapping key, token expiry and days left |
| `master-key-usage.sql` | superuser only (refuses others) | Stored sealed rows by master-key id: which keys can leave the ring |
| `audit-window.sql` | superuser only (refuses others) | Audit rows in a time window by action and actor kind, tenants touched, and operator actions. Needs `since` |

## Not built (and who can build it)

Several runbooks describe operating pieces that do not exist yet. They are listed so a reader is not
surprised mid-incident; each also says so in its own table. The owners are in
`docs/evidence/ws-8-ops.md`, "Integration notes".

| Not built | Affects |
| --- | --- |
| Webhook routes, the `webhook_events` table, the `webhook.process` handler, Shopify webhook subscriptions, a reconciliation job, `rsctl webhooks` | [Webhook backlog](webhook-backlog.md) |
| `rsctl jobs list`, `retry`, `depth`; queue depth and dead-job metrics | [Dead-letter triage](dead-letter-triage.md) (the SQL files stand in) |
| A job that re-wraps stored values with `KeyRing::rewrap`; a staging mode for `rsctl keys rotate` | [Rotate the master key](rotate-token-master-key.md) |
| Wiring of the previous webhook secret (`WebhookVerifier::with_previous`); `GITHUB_APP_PRIVATE_KEY` in the `ctl` configuration | [Rotate the GitHub App key](rotate-github-app-key.md) |
| The engine's ai worker, the Postgres budget ledger and `ai_calls`, a breaker metric, a spend metric | [AI provider outage](ai-provider-outage.md) |
| Grafana alert rules, the synthetic journey, a backup-freshness monitor | the alert table above |
| A way to email all affected merchants; a named second person for break-glass; per-feature flags | [Incident response](incident-response-and-postmortem.md) |
| A rehearsed cutover of a PITR fork (rename of services) and a measured restore of a production-sized database | [Restore from PITR](restore-from-pitr.md) |

## Conventions

- **Secrets never go on a command line.** Values are read with `read -rs` into a variable, passed on
  standard input, or kept in a mode-0600 header file that `curl -H @file` reads, and removed after.
  Rings and keys come from the offline vault (PLAN §22), never from a Railway variable: sealed
  variables cannot be read back.
- **Name the environment** in every Railway command: `--environment production` or `--environment
  staging`. Do production work only after the same steps worked in staging, unless the runbook says it
  is an emergency.
- **Railway CLI 5.70.0** is the version `deploy.yml` pins; commands are taken from its reference.
- **Tenants are counted, never named,** in tickets and postmortems. Payloads are never pasted.
- **Banned claims** (PLAN §3) apply to anything a merchant reads, including incident notices.

## Keeping them true

A runbook states what was verified and on which date. Each quarterly restore drill (PLAN §24) starts with
reading all nine against the code, and an incident that used a runbook ends by correcting every command
that did not work as written, in the incident's pull request. Where a runbook says "not built" and the
piece is built later, the same pull request changes the runbook and adds its test.
