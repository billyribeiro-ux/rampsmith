# ADR-133: Alt-text draft allowance windows

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-4 (`crates/billing`)

## Context

PLAN §20 gives each plan "alt-text drafts per month": 25 once on Free, then 2,000, 10,000 and
50,000. It does not say what a month is. Shopify App Pricing bills monthly plans every 30 days
and yearly plans once a year; the Partner API reports the current cycle as
`currentBillingCycle { startTime endTime }`, which is null during a trial
(<https://shopify.dev/docs/api/partner/latest/active-subscription>, read 2026-10-17). A yearly
plan has no monthly cycle at all, so the billing cycle cannot be the allowance window for every
plan.

## Decision

1. Paid plans renew their allowance in **monthly windows** `[start, end)` anchored to the
   shop's **usage anchor**: each window starts on the anchor's day of month at the anchor's UTC
   time of day. In a month too short for that day, the window starts on the month's last day
   (anchor 31 January gives 28 February, or 29 in a leap year, then 31 March).
   `billing::usage::monthly_window(anchor, now)` computes it.
2. The usage anchor is set by plan-state reconciliation (ADR-131) when a shop moves onto a paid
   plan from Free or from no plan: the start of the current billing cycle when Shopify reports
   one that has begun, otherwise the moment the paid plan was first confirmed. It is kept across
   paid-to-paid plan and interval changes and renewals, and cleared when the shop leaves paid
   plans. Without an anchor the windows fall back to UTC calendar months.
3. A mid-window plan change keeps the window: drafts already used count against the new plan's
   limit (Starter with 1,500 used, upgraded to Growth, has 8,500 left; Growth with 3,000 used,
   downgraded to Starter, has none until the window renews).
4. Free's allowance is a lifetime allowance ("25, once"): every draft the shop has ever
   received counts, on whichever plan it was produced, so a shop that returns to Free after a
   paid plan gets no new drafts.
5. `billing::remaining_alt_text_drafts(plan, usage, usage_anchor, now)` is pure: it takes the
   recorded `usage_events` rows (instant and quantity), reads the allowance from
   `entitlements(plan)` (ADR-132) and returns used, remaining and the renewal instant. Sums
   saturate; out-of-range dates are typed errors.

## Consequences

- Merchants see one renewal day per month ("renews on the 15th"), on every plan and interval.
- Changing plans cannot be used to reset the allowance, and an upgrade gives the difference
  between the two limits at once.
- The integrator stores `usage_anchor_at` with the plan state and passes the window's
  `usage_events` (or all of them for Free) to the function.

## Rejected alternatives

- Shopify's 30-day billing cycle as the window: yearly plans and trials have none, and it would
  give monthly and yearly payers different renewal behaviour.
- Plain UTC calendar months for everyone: a shop subscribing on the 30th would get two full
  allowances within two days.
- Resetting the window at every plan change: lets a shop reset its allowance by switching plans.
