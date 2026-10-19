# ADR-214: AI cost accounting and the per-store monthly budget

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §9, §13, §20)

## Context

PLAN §13: "Every call is logged with its model, tokens, cost and prompt version, and every
tenant has a monthly AI budget enforced before the call is made." §9 keeps `ai_calls` with
model, tokens, cache reads, cost in micro-dollars, batch id, prompt version and outcome; §19
keeps that metadata 13 months and never the prompt content. §20 maps plans to limits in one
Rust function, and the merchant can set an AI budget in `/settings` (§14).

## Decision

1. **Cost** is computed from the response's `usage` with the documented prices (ADR-212):
   uncached input, output (thinking included), cache reads, and 5-minute and 1-hour cache
   writes, each at its own price; the Haiku 5.5 tier is chosen from the whole prompt length;
   the Batch API halves the total. Money is integer micro-dollars, computed exactly in
   pico-dollars and rounded up, so the ledger never under-counts.
2. **Guard.** Before a call, the worst case is reserved against the tenant's limit for the UTC
   month: every estimated input token at the 1-hour cache-write price (the dearest input
   category) plus every allowed output token. Image tokens are exact; text tokens are
   overestimated (one per three ASCII characters, 1.5 per other character, plus 10%), plus 400
   tokens for the structured-outputs system prompt. A call the budget cannot cover fails with
   `ai_budget_exhausted` (permanent) and is never sent. After the call the reservation settles
   at the actual cost. HTTP errors are unbilled and release it; a timeout, dropped connection
   or abort may have been billed, so the worst case is kept and the record says
   `costIsEstimate: true`; when such an attempt is followed by a retry that succeeds, the call
   settles at the success's cost plus the worst case of each ambiguous attempt (ADR-215).
   Batches reserve per item at batch prices when submitted and settle
   per item when collected; `errored`, `expired` and `canceled` items are released.
3. **The limit is a parameter** (`AiDeps.budgetLimit(tenantId)`), read from the entitlements
   function and the merchant's own lower setting. Proposed defaults for that function, about
   ten times each plan's expected monthly spend, so a cap stops abuse and never ordinary use:
   Free $0.50, Starter $5, Growth $20, Pro $60. The draft counts per month in §20 (25 once,
   2,000, 10,000, 50,000) stay an entitlement the scheduler enforces before enqueuing.
4. **Ledger.** `BudgetLedger` (`reserve`, `settle`, `release`; idempotent, because jobs run at
   least once) has an in-memory reference implementation. The engine implements it on
   PostgreSQL in one tenant-owned table under `TenantTx` and row-level security, for example
   `ai_budget_reservations (id uuid, tenant_id uuid, period text, amount_micro_usd bigint,
   actual_micro_usd bigint null, state text check (state in ('held','settled','released')),
   created_at timestamptz)`, reserving with an insert that sums held and settled amounts for
   the tenant and period under a per-tenant advisory lock.
5. **Records.** Every call that reached the provider produces one `AiCallRecord`: tenant,
   task, model, mode, prompt version, the five token counts, thinking tokens, cost, whether the
   cost is an estimate, batch id, request id, outcome (`ok`, `needs_review`, `refused`,
   `truncated`, `malformed`, `error`), error code, attempts, duration and start time. No prompt
   text, no output, no merchant content. The same call emits an OpenTelemetry span
   (`ai.<task>`, GenAI attributes) and the metrics `rampsmith.ai.calls`,
   `rampsmith.ai.cost` and `rampsmith.ai.call.duration`.

## Consequences

- A tenant cannot spend past its limit by more than the gap between estimate and actual of
  calls in flight, and the estimate is deliberately high.
- An outage that times out many calls charges the worst case to budgets; the circuit breaker
  (ADR-215) keeps that to a handful of calls.
- `ai_calls` needs more columns than §9 lists, and the engine needs the reservation table.

## Plan correction

- PLAN §9 Supporting tables, `ai_calls`: "Tenant, task, model, mode, prompt version, input,
  output, cache-read, 5-minute and 1-hour cache-write and thinking tokens, cost in
  micro-dollars and whether it is an estimate, batch id, request id, outcome, error code,
  attempts, duration". Add `ai_budget_reservations` (ADR-214).
- PLAN §20 Billing mechanics, Entitlements: the entitlements function also returns the monthly
  AI budget in micro-dollars (proposed: Free $0.50, Starter $5, Growth $20, Pro $60), which the
  merchant can lower in `/settings`.

## Rejected alternatives

- Checking spend after the call: PLAN §13 requires enforcement before the call.
- Counting calls instead of money: an Opus patch and a Haiku alt text differ by four orders of
  magnitude.
- Relying on the Console spend limit alone: it is per organization, not per store.
