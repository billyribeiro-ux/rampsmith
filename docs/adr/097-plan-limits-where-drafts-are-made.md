# ADR-097: The plan's AI budget and draft allowance are enforced where drafts are made

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-084, ADR-090, ADR-133, ADR-214, PLAN §20
- Lane: R1 lane C security audit, findings M2, M3

## Context

The api clamped the merchant's AI budget to the plan's ceiling and showed the remaining draft
allowance, but the engine, which makes the drafts, read the raw `sites.settings` value and had
no allowance check at all: a Free store could be drafted past its 25 drafts, and a Starter store
past its budget, by whatever `audit.data` queued (up to 500 per batch).

## Decision

1. **One source for the limits.** `shop_billing` gains `effective_plan`,
   `ai_budget_max_micro_usd`, `alt_text_draft_limit` and `alt_text_draft_lifetime`.
   `db::repo::shop_billing::put`, the only writer, derives them from `billing::stored::limits_of`
   (which reads `billing::entitlements`) every time a plan state is stored, so the webhook, the
   redirect check and the plan sweep all keep them current. The engine reads the row and keeps no
   plan table of its own. A shop with no row is on Free, as in the api.
2. **Budget.** The engine spends `min(setting ?? ceiling, ceiling)`, the value the api shows.
   An `alt_text_max_characters` outside 40 to 300 is ignored (the default applies) instead of
   failing every image.
3. **Allowance.** Remaining drafts = limit minus the alt-text `ai_calls` that finished `ok` or
   `needs_review` (all of them for Free, those in the current monthly window for paid plans,
   windows anchored at `usage_anchor`; the window arithmetic is a TypeScript twin of
   `billing::usage::monthly_window`, tested on the same vectors), minus the drafts other jobs hold.
4. **A hold before the model call.** A job takes a row in `ai_draft_holds` under a per-tenant
   `pg_advisory_xact_lock`, after counting `ai_calls` and the other holds, and deletes it when
   its calls are recorded (a 10 minute expiry covers a crash). It holds two units when the
   allowance has room for an escalation and one otherwise; with one, the escalation to Sonnet is
   not allowed. Two concurrent jobs therefore cannot both take the last draft. A re-check in
   `store()` would be too late, since the money is spent by then, so the hold replaces it.
5. **When the allowance is out.** Free (it never renews): the job fails permanently with
   `ai_draft_allowance_exhausted`. A paid plan: the job is deferred to the renewal date (ADR-098).
   When only other jobs' holds are in the way, it is deferred 30 seconds. Nothing is downloaded or
   sent while the allowance is out.
6. **Enqueue.** `audit.data` queues no more jobs than the allowance has room for after the
   drafts in flight and the jobs already waiting. Findings left without a job stay open for a later
   scan (a job that was never queued holds no idempotency key).

## Consequences

A downgrade or an upgrade takes effect on the next `put`. If a deploy ever adds a plan, the
`entitlements` function is the only place to change; the migration's backfill covers rows stored
before this ADR only.
