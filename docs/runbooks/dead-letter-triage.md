# Dead-letter triage

| | |
| --- | --- |
| Answers | PLAN §21 page "Any dead job in `shopify.*`, `github.*` or token-refresh queues"; the SLO "Shops losing access because Rampsmith failed to refresh a token" (target 0); the ticket "Oldest ready scan job older than 10 minutes" when dead jobs hold up a chain |
| Severity | SEV2 as paged (a dead token-refresh job is a shop that will lose access); SEV3 for other queues |
| Use it when | The page fires; a `job is dead` line appears in the logs; `jobs-depth.sql` shows a non-zero `dead` row; after any outage, to sweep what the outage killed |
| Decisions behind it | ADR-018 (the queue protocol), ADR-022 (token refresh), ADR-178 (this triage and the SQL) |
| Verified | 2026-10-19. The SQL files run on every pull request against PostgreSQL 18.6 with the repository migrations, seeded jobs in every state, as the superuser and as `rampsmith_ctl` (45 checks, `infra/restore-drill/tests/runbook-sql.sh`). **Not run on Railway**: Section E row |

## What exists, and what does not

| Piece | State |
| --- | --- |
| The queue, retries with backoff, the lease reaper, `queue::retry_dead` | Built (`crates/queue`) |
| The warning `job is dead` with the queue and the job id in the worker's log | Built |
| `docs/runbooks/sql/jobs-depth.sql`, `jobs-dead.sql`, `jobs-retry-dead.sql`, `jobs-token-state.sql` | Built and tested |
| `rsctl jobs list`, `rsctl jobs retry`, `rsctl jobs depth` | **Not built.** `rsctl` has `doctor` and `keys` only. The `queue::retry_dead` comment says retries belong to `rsctl jobs retry`; `jobs-retry-dead.sql` stands in and adds the audit row |
| A metric that counts dead jobs, and the queue depth and age gauge | **Not built.** The exported instruments are `rampsmith.queue.attempts` (outcomes `succeeded`, `retryable`, `permanent`, `lease_lost`) and `rampsmith.queue.claim.duration`. A job that used up retryable attempts is counted `retryable` and still dies, so only the log line and the database see a dead job. The page in PLAN §21 needs a log-based rule on `job is dead` until a metric exists (ADR-179) |
| Queues that exist today | `shopify.token_refresh` (in `ctl`); `scan.page` jobs appear in the seed. `webhook.process`, `github.*`, `ai.*` and the rest are named in PLAN §10 and are **not built** |

## How a job dies

A worker claims a job with a lease and runs it. On failure it is *retryable* or *permanent*. A retryable failure with attempts left becomes `ready` again after a delay of `5 s × 2^(attempt − 1)` capped at one hour, with jitter; the default budget is 8 attempts. A permanent failure, or the last retryable one, makes the job `dead` and records `last_error` = `{code, message, retryable}`. A worker that stops without finishing loses its lease; the leader `ctl` returns the job to `ready` (or `dead` with code `lease_expired` when no attempts remain) every 10 seconds. Dead jobs stay in the table. Nothing retries them by itself.

## 1. Acknowledge and look

1. Acknowledge the page (do not mute it) and open a ticket; write the time and which queue paged.
2. Open a break-glass session ([incident response](incident-response-and-postmortem.md): write the start and end in the ticket). From a checkout root:

```sh
railway link          # once
railway connect postgres --environment production --ssh      # psql 15 or newer on your machine
```

3. At the psql prompt (the files `set role rampsmith_worker` themselves: they see every job and nothing tenant-owned, even from the superuser login):

```text
\i docs/runbooks/sql/jobs-depth.sql
\i docs/runbooks/sql/jobs-dead.sql
```

`jobs-depth.sql` shows, per queue and state, how many jobs there are and how long the oldest ready one has waited. `jobs-dead.sql` prints dead jobs grouped by queue and error code, then the newest ones. To narrow it: `\set queue 'shopify.%'`, `\set code crypto`, `\set limit 20`, then `\i` the file again. Payloads are not printed; never paste one into a ticket.

4. The log side: `railway logs --service ctl --environment production --since 2h --filter "job is dead"`.

## 2. Classify by error code

| `last_error.code` | What it means | Do |
| --- | --- | --- |
| `shopify_unavailable`, `database` | Retryable failures that used all 8 attempts. The delays are 5 s doubling (5, 10, 20 … 320 s, each between half and all of that), so the budget is spent in 5 to 11 minutes: a Shopify or database outage longer than that kills the jobs it touches | Find the outage: <https://shopifystatus.com>, <https://status.railway.com>, database load and connections. Retry after recovery |
| `shopify_rejected` | Shopify refused a refresh in a way that is not "revoked" | Do **not** retry blindly. Read the message. Check the app's credentials with `rsctl doctor --row 1`. A rotated client secret not yet deployed is the likeliest cause |
| `crypto` | A stored value does not open with the ring | Stop. A key was dropped or the ring is wrong: [rotate the master key](rotate-token-master-key.md), "A wrong drop". Retry only after the ring is right |
| `payload_schema_unknown`, `payload_invalid`, `tenant_missing` | Version skew or a bug in whatever enqueued the job | Find the enqueuer (`jobs.created_at`, `jobs.traceparent`, the deploy around it). Fix forward; retry after the fixed build is live |
| `lease_expired` | The worker died or stalled | Check `ctl` for restarts and memory (`railway deployment list --service ctl --environment production`, the logs). Safe to retry |
| `(none)`, or a code not listed | Unknown | Escalate. Do not retry |

A group of dead jobs usually has one cause. Triage the group, not each job.

## 3. If the queue is `shopify.token_refresh`

A dead refresh job is urgent beyond its own page. The job is the weekly keep-alive: success enqueues the next one, failure does not, so that shop's chain is broken until it succeeds or the shop exchanges a token again. The refresh token expires 90 days after it was issued (PLAN §14). For each job, as the superuser (this file refuses any other role):

```text
\set job <job id from jobs-dead.sql>
\i docs/runbooks/sql/jobs-token-state.sql
```

It prints the shop id and status, the key that wraps its tokens, when the access and refresh tokens expire and `refresh_days_left`. Read it:

- **Token columns empty:** the tokens are gone (Shopify revoked them, or the shop uninstalled). Retrying cannot help; the merchant re-authenticates the next time they open the app. Note it in the ticket and leave the job dead.
- **`refresh_days_left` large and the cause fixed:** retry (step 4).
- **`refresh_days_left` small:** retry now and say so in the ticket; if the refresh keeps failing the shop will lose access on that date. Escalate to the founder, who decides whether to contact the merchant.

## 4. Retry (only when the cause is understood and fixed)

One job at a time, naming yourself and the cause (no personal data in the reason):

```text
\set job <job id>
\set operator <your name>
\set reason 'ctl restarted after the 14:02 deploy'
\i docs/runbooks/sql/jobs-retry-dead.sql
```

It prints the job before, then `retried` and `audited`. `1 1` means the job is `ready` again with a fresh budget (`attempts = 0`) and an `audit_log` row `job.retried` (actor kind `operator`) records who and why. `0 0` means the job was not dead (or not found) and nothing changed. `1 0` is a system job: it has no tenant, so it cannot be audited; write the id and cause in the ticket. A retried job runs at once.

After a group is retried, watch it:

```text
\i docs/runbooks/sql/jobs-depth.sql
```

the `dead` count for the queue falls, `ready` rises then falls, and no new `dead` rows appear. A job that dies again with the same code was not fixed: stop and go back to step 2.

## 5. What not to do

- Do not retry a dead job whose code you cannot explain. A permanent failure retried is a permanent failure, three more times.
- Do not retry a whole queue with one statement. The files take one id on purpose.
- Do not change a job's payload, state or `max_attempts` by hand. If the payload is wrong, the enqueuer is.
- Do not connect as the superuser for convenience: the files `set role rampsmith_worker` so a typo cannot touch tenant data. Only `jobs-token-state.sql` and `master-key-usage.sql` need the superuser, and say so.

## Verify (done means)

- `jobs-dead.sql` shows no dead job for the queue that paged, or each remaining one has a ticket line saying why it stays dead.
- For token refresh: every shop in the group either refreshed (its `jobs` row `succeeded`, a `shopify.token_refreshed` audit row) or is recorded as revoked.
- The cause is named in the ticket, and a fix or a follow-up exists for it.

## Rollback

A retry cannot be undone, but it is only another attempt: if the job dies again it is dead again with a new `last_error`. The `audit_log` row stays (it is append-only).

## Escalation

- Many shops' refresh jobs dead at once, `crypto` codes, or tokens near expiry: SEV1, the founder, [incident response](incident-response-and-postmortem.md).
- A code you cannot place: the engineer who owns the queue's handler (`ctl`: token refresh; the rest as they are built).
- The database itself unhealthy: [restore from PITR](restore-from-pitr.md) for damage, Railway's status for the platform.
