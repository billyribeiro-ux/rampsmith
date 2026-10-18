# ADR-215: Retries, timeouts, the provider-outage behaviour and the batch lifecycle

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §10, §13)

## Context

PLAN §13: "HTTP 429 and overload responses retry with backoff; a circuit breaker pauses AI
queues after repeated failures, and scans continue without AI drafts." The queue (§10, ADR-018)
already retries jobs with exponential backoff capped at an hour. The documented error model
(ADR-212) separates transient failures (429 with `retry-after`, 500, 504, 529, connection
errors) from ones no retry fixes (400, 401, 403, 404, 413, spend caps).

## Decision

1. **Classification.** Every failure becomes an `AiError` with a stable code and a `retryable`
   flag the queue uses: transient codes, `ai_unavailable`, `ai_spend_limit` and `ai_auth` are
   retryable at the job level (fixing the key or raising the limit lets queued jobs finish);
   `ai_invalid_request`, `ai_request_too_large`, `ai_refused`, `ai_output_truncated`,
   `ai_output_malformed`, `ai_budget_exhausted` and `ai_input_invalid` are permanent. Messages
   carry the status, the error type and the request id, never the provider's message text.
2. **Retries inside a call**: at most 3 attempts for `ai_rate_limited`, `ai_overloaded`,
   `ai_server_error`, `ai_timeout` and `ai_connection`. `retry-after` (or `retry-after-ms`)
   wins when present; a wait longer than 30 seconds hands the job back to the queue instead.
   Otherwise the delay is exponential with equal jitter from 1 second, capped at 16 seconds.
   The SDK's own retries are off.
3. **Timeouts** per route (ADR-212): 60 s for alt text and tie-breaks, 90 s for escalations and
   the grader, 120 s for rewrites, 600 s for a synchronous patch proposal (which normally runs
   in a batch). The caller's `AbortSignal` (a lost lease) aborts the call.
4. **Circuit breaker** per engine process: five consecutive capacity failures open it for 30
   seconds, doubling after each failed probe up to 10 minutes; a spend limit or a rejected key
   opens it at once for an hour. While open, calls fail fast with `ai_unavailable` and
   `retryAfterMs`, and `pausedUntil()` tells the ai worker to stop claiming `ai.*` jobs. Half
   open, one probe goes through. Any answer from the API (even a 400 or a refusal) proves it is
   up and closes the circuit.
5. **Batches.** `submitBatch` checks `custom_id`s, refuses a batch over the documented limits
   (`chunkBatchItems` splits by 100,000 requests and 200 MB), reserves each item's budget and
   creates the batch with the same retry policy, releasing every reservation if creation
   fails. It returns a `BatchTicket` (plain JSON, no prompt content) for the job payload.
   `pollBatch` reads the status; `collectBatch` streams the results in any order, matches them
   by `custom_id`, settles and records each item, interprets it with the call the engine
   rebuilds from stored input (refusing a rebuild whose prompt version or task differs), and
   treats a missing result like an expired one. `retireBatch` then deletes the batch, so
   Anthropic does not keep its inputs and outputs for 29 days; deleting twice is harmless.

## Consequences

- During an outage each engine process makes a handful of calls, then pauses AI work; scans,
  recipes and data fixes carry on.
- A malformed answer is a dead job, visible in queue metrics, never a silent retry loop.
- The breaker is per process; with several engine replicas each opens on its own, which bounds
  wasted calls at a few per replica.

## Plan correction

- PLAN §13 "Data handling and resilience", third bullet: "HTTP 429, 5xx, 529 and connection
  failures retry up to three times within a call, honouring `retry-after`; a spend limit or a
  rejected key opens the circuit breaker at once; five consecutive failures open it for 30
  seconds, doubling up to 10 minutes; while it is open the ai worker stops claiming AI jobs and
  scans continue without AI drafts. Batches are deleted from Anthropic as soon as their
  results are stored."

## Rejected alternatives

- The SDK's built-in retries: invisible to the breaker and to cost accounting.
- A shared breaker in PostgreSQL: one more table and query per call for little gain at the
  current scale; revisit when the engine runs many replicas.
