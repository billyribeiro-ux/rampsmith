# ADR-086: A stored webhook event is retried for days and swept (audit M2)

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-080, ADR-085
- Fixes: lane A audit M2

## Context

The listener answers 200 as soon as the event row and its `webhook.process` job are stored, so
Shopify never retries it. The job had the queue default of 8 attempts, about ten minutes of
backoff. A Shopify outage or an engine bug longer than that left the event unprocessed for good,
and for `shop/redact` and `customers/*` that is a legal deadline (PLAN §19).

## Decision

1. `WebhookProcess::MAX_ATTEMPTS` is 96 and the listener sets it on the job. The backoff is
   capped at one hour with equal jitter (a delay is between a half and the whole of the capped
   value), so 96 attempts span at least two days and on average over three.
2. `webhook_events_sweep()` (migration `20261105000002`, security definer, executable by the
   worker role only, ages fixed in the function) gives a new job to every event unprocessed for
   30 minutes that has no `ready` or `running` job, at most once per hour per event and for 14
   days after arrival. It returns how many it queued, how many events have waited 24 hours or
   more, and the age of the oldest.
3. ctl's leader runs the sweep every 5 minutes (`Cadence::webhook_sweep_every`). While any event
   has waited 24 hours it logs an error with the field `webhook_event_stuck` on every run. That
   log line, and any dead `webhook.process` job, page (`docs/runbooks/README.md`).

## Consequences

- A job that dies still pages; the sweep then gives the event a fresh budget, so the page is
  about attention, not data loss.
- An event that can never succeed (a permanent failure such as `shop_mismatch`) is requeued hourly
  for 14 days, then only counted; it needs an operator either way.
- There is no metric yet; the alert is a log rule like the other queue alerts.
