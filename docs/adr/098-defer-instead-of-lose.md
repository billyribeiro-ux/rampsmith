# ADR-098: Outages and a missing key defer the job; they do not spend its attempts

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-018, ADR-090, PLAN §10
- Lane: R1 lane C security audit, findings L3, L5

## Context

A job that fails retryably spends one of its eight attempts, and the backoff caps at an hour, so a
provider outage of a few hours, an open circuit breaker or a missing `ANTHROPIC_API_KEY` killed
the job. The idempotency key `ai.alt_text:<finding_id>` with `on conflict do nothing` then kept
the draft from ever being queued again.

## Decision

1. **A third failure kind, `defer`**, in `@rampsmith/queue` (`JobFailure('defer', error,
   { delayMs })`): the job becomes `ready` again after the delay, bounded to 5 seconds at least and
   35 days at most, and the attempt is given back (`attempts - 1`), so a deferral never ends a
   job. Rust consumers are unaffected; nothing in `crates/queue` raises it.
2. **The alt-text job defers** when the breaker is open (`ai_unavailable`, at the time the breaker
   names), on `ai_auth` and `ai_spend_limit` (the provider's `retryAfterMs`, else one hour), on
   rate limits and overload (`retryAfterMs`, else a minute), when `ANTHROPIC_API_KEY` is not set
   (one hour; the founder input is LAUNCH.md section C, row 5), and when the plan's allowance
   renews later (ADR-097). Other failures keep their kind.
3. **The lease signal reaches the work.** `JobHandler` takes the worker's `signal`, which aborts
   when the lease is lost; the alt-text job passes it to the image download (which closes the
   tunnel) and to the model call, so a worker that lost its lease stops paying for work another
   attempt will redo.
4. **A stale finding is not drafted.** `store()` re-reads the finding's status under the row lock
   and returns unless it is `open`.

## Consequences

Thousands of deferred jobs wake together when an outage ends; the queue's claim loop and the
per-tenant allowance and budget limit the burst. A job that can never succeed still dies: only
causes outside the job defer it.
