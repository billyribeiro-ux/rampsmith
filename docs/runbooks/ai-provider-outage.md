# AI provider outage

| | |
| --- | --- |
| Answers | PLAN §21 tickets "AI circuit breaker open for more than 15 minutes" and "Daily AI spend above twice its trailing average"; PLAN §13 ("a circuit breaker pauses AI queues after repeated failures, and scans continue without AI drafts") |
| Severity | SEV3: AI drafts are late or missing while scans, recipes and data fixes carry on. SEV2 if scans or fixes are affected too, or if spend is running away |
| Use it when | The Anthropic API is failing or slow; the breaker is open; a spend limit or a rejected key stops calls; AI spend jumps; orphaned batches need cleaning |
| Decisions behind it | ADR-178; the AI library's ADR-211 to ADR-217 and `docs/evidence/ws-12-ai.md` (branch `ws/ai`, package `@rampsmith/ai`) |
| Verified | 2026-10-19 against the AI library's ADRs and tests (359 passing, recorded responses) and `rsctl doctor`'s Anthropic probe (ADR-152). **Most of the engine side is not built**, so several steps cannot run yet. The table says which. Nothing here was run against the live API: needs LAUNCH.md C row 5 |

## What exists, and what does not

| Piece | State |
| --- | --- |
| `@rampsmith/ai`: error codes, retries, per-process circuit breaker (`pausedUntil()`), cost accounting, batch lifecycle | Built on `ws/ai` |
| The engine's ai worker that claims `ai.*` jobs and stops while the breaker is open | **Not built** (listed as work for the engine in `docs/evidence/ws-12-ai.md`) |
| `BudgetLedger` on PostgreSQL (per-store monthly budget) and the `ai_calls` table | **Not built** (in-memory reference only) |
| A metric or log for "breaker open", and a spend metric | **Not built**: the ticket alerts in PLAN §21 have no signal behind them (ADR-179). Spend is visible only in the Anthropic Console |
| `rsctl doctor --row 5` (lists models with the key, checks the three PLAN §13 models are there) | Built on `ws/rsctl` |
| The jobs tooling | Built ([dead-letter triage](dead-letter-triage.md)) |

## How the code behaves in an outage (so you know what is normal)

- A failed call retries inside the call up to 3 times for rate limits, overload, server errors, timeouts and dropped connections (`retry-after` wins; a wait over 30 s hands the job back to the queue).
- **Five consecutive capacity failures open the breaker for 30 seconds**, doubling after each failed probe up to 10 minutes. A **spend limit or a rejected key opens it at once for an hour.** While it is open calls fail fast with `ai_unavailable` and the ai worker stops claiming `ai.*` jobs, so queued jobs wait `ready` instead of burning attempts. One probe goes through when it half-opens; any answer from the API, even a 400, closes it. The breaker is per engine process.
- Error codes: `ai_rate_limited`, `ai_overloaded`, `ai_server_error`, `ai_timeout`, `ai_connection` (the provider); `ai_unavailable` (the breaker is open); `ai_spend_limit` and `ai_auth` (the account); `ai_budget_exhausted` (**one store's** monthly budget, not an outage; permanent, the call is never sent); `ai_invalid_request`, `ai_request_too_large`, `ai_refused`, `ai_output_truncated`, `ai_output_malformed`, `ai_input_invalid` (permanent, not an outage). Messages carry the status, error type and request id, never the provider's text.
- A timed-out or dropped call may still have been billed, so the library charges the worst case for it. The budget can therefore overstate spend during an outage; the Console shows what was actually billed.

## 1. Confirm it is the provider

1. Ticket with the time and the symptom (drafts missing or late, `ai.*` queue growing, dead jobs with `ai_*` codes).
2. The provider's status: <https://status.claude.com>. An open incident explains it; note its link in the ticket.
3. The key and the API from your side:

```sh
ANTHROPIC_API_KEY="$(<from the vault>)" rsctl doctor --row 5
```

(Read the key with `read -rs` into the variable, as in the other runbooks, rather than typing it.) `PASS` means the key lists models and the three PLAN §13 models are among them. A 401 means the key was rejected (step 3). A timeout or 5xx is the provider.
4. Check what still works: scans and data fixes do not call the model. If they fail, this is not (only) an AI outage: open SEV2 and use [incident response](incident-response-and-postmortem.md).

## 2. Provider outage (`ai_rate_limited`, `ai_overloaded`, `ai_server_error`, `ai_timeout`, `ai_connection`, `ai_unavailable`)

**Do nothing to the breaker.** It probes by itself and bounds the calls made. Specifically do not:

- raise engine concurrency, retry jobs by hand, or restart the engine to "clear" the breaker (a restart resets it and sends a burst of calls into the outage);
- switch the model ids: the models and prompts are gated by the evaluation in PLAN §13;
- turn on a different provider: not part of the design.

Tell the support view's owner that AI drafts are paused. When the provider recovers, the next half-open probe closes the breaker and the ai worker resumes.

After recovery, sweep what the outage killed (retryable codes can still die when a job was already running at the moment the breaker opened):

```sh
railway connect postgres --environment production --ssh
```

```text
\set queue 'ai.%'
\i docs/runbooks/sql/jobs-dead.sql
```

For dead jobs with codes `ai_rate_limited`, `ai_overloaded`, `ai_server_error`, `ai_timeout`, `ai_connection`, `ai_unavailable`, `ai_spend_limit` or `ai_auth`, once the provider is healthy, retry them one at a time with `jobs-retry-dead.sql` ([dead-letter triage](dead-letter-triage.md), step 4). Leave the permanent codes alone; each has its own cause.

## 3. A rejected key (`ai_auth`) or an exhausted spend limit (`ai_spend_limit`)

Either opens the breaker for an hour. Both are account actions in the Anthropic Console, which belong to the founder. **Raising a spend limit is spending money: the founder decides.** Write the decision in the ticket.

- **Rejected key:** was it revoked or rotated? Create a new key in the Console, put it in the vault, set the shared variable `ANTHROPIC_API_KEY` (service `engine`; sealed, so edit it from its menu) in Railway, review the staged change and Deploy. Check `rsctl doctor --row 5`. The breaker closes at the next probe after its hour, or sooner when the engine restarts with a working key. Delete the old key in the Console.
- **Spend limit reached:** check whether the spend was legitimate (step 5). If it was, the founder raises the Console limit or waits for the next period; if it was not, treat it as step 5.

## 4. Orphaned batches

A batch creation that timed out may still have created a batch upstream; its cost is already counted (ADR-215). Unclaimed batches expire within 24 hours, and their results are deleted after 29 days if not deleted first. To find and remove them, with the production key held in a private header file (never on a command line):

```sh
umask 077
read -rsp 'ANTHROPIC_API_KEY: ' KEY; echo
printf 'x-api-key: %s\nanthropic-version: 2023-06-01\n' "$KEY" > ./anthropic-header.txt; unset KEY
curl -sS "https://api.anthropic.com/v1/messages/batches?limit=100" -H @./anthropic-header.txt
```

For every batch whose id is not named in a stored `BatchTicket` (the ticket lives in the `ai.*` job payload; its shape is the engine owner's and is not built yet):

```sh
curl -sS -X POST   "https://api.anthropic.com/v1/messages/batches/<id>/cancel" -H @./anthropic-header.txt   # if still in progress
curl -sS -X DELETE "https://api.anthropic.com/v1/messages/batches/<id>"        -H @./anthropic-header.txt   # once ended
rm -f ./anthropic-header.txt
```

Never delete a batch that a stored ticket names: its results have not been collected.

## 5. Spend above twice the trailing average

No spend metric exists (not built). Use the Console's usage for the key and the day.

1. Is it growth (new stores, a new feature) or a loop (the same call repeated, a retry storm, a prompt change that made inputs larger)? Look at the shape: a loop is flat-topped and fast.
2. **Emergency stop for a loop:** have the founder revoke the key in the Console. Calls then fail with `ai_auth`, the breaker opens for an hour and scans continue without AI drafts. This costs nothing and is reversible with a new key (step 3). Do not stop the whole `engine` for this: it stops scanning too.
3. Find the cause (logs of the engine for the task and prompt version, `railway logs --service engine --environment production --since 2h --filter "ai_"`), fix it, then restore the key.
4. The per-store budget (`ai_budget_exhausted`) is the control that should have capped a single store; it cannot yet (the ledger is not built). Say so in the postmortem.

## Verify (done means)

- `rsctl doctor --row 5` passes; the provider's incident (if any) is resolved.
- The breaker is closed: new AI drafts are produced for a test scan on staging, or the engine's log shows successful calls.
- `jobs-dead.sql` with `\set queue 'ai.%'` shows no dead job without a ticket line.
- Orphaned batches are cancelled or deleted, and the Console spend matches expectations.

## Rollback

Nothing in steps 1 and 2 changes state. A new key (step 3) can be replaced by another one. Deleted batches cannot be restored: only delete those no ticket names.

## Escalation

- Provider incident: <https://status.claude.com>; for account problems (limits, keys), the Anthropic Console and support. Quote request ids (`req_…`) from the engine's error messages.
- Spend: the founder, always, before any limit is raised.
- AI drafts wrong rather than missing (an evaluation or safety problem, not an outage): stop approving in bulk, SEV2, [incident response](incident-response-and-postmortem.md).
