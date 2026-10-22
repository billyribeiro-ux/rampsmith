# ADR-084: Plan state in the api, and Partner API fairness (audit M3)

- Status: Accepted
- Date: 2026-10-22
- Refines: PLAN §20; ADR-131 to ADR-134 (the billing crate)

## Decision

**Stored plan.** `shop_billing` (migration `20261103000002`, row-level security, composite key to
the shop) stores `billing::BillingState` as text and timestamps (`billing::stored`). Only a Partner
API answer, passed through `billing::reconcile`, writes it. A shop with no row, or a row that does
not parse, has an unconfirmed plan and gets Free's entitlements. `shopify_shops.shop_gid` holds
Shopify's own id for the shop, recorded by `shopify.read_store`; the Partner API names a shop by it.

**Where the plan is used.** `getOverview`, `getSettings` and the other operations read the stored
plan through `billing::stored::entitlements_of`; `approveFix` applies `image_fix_gate`;
`updateSettings` refuses a weekly rescan on a monthly cadence and limits `ai_budget_micro_usd` to
the new `Entitlements::ai_budget_micro_usd` ceiling (ADR-214's proposal: Free 0.50, Starter 5,
Growth 20, Pro 60 US dollars, in micro-dollars); `shopify.read_store` writes the plan's render
sampling into the `shop` scan input (`home_plus` or `per_template`). Draft usage is counted from
`ai_calls` (tasks `alt_text` and `alt_text_escalated`, outcomes `ok` and `needs_review`) and fed to
`remaining_alt_text_drafts` with the stored `usage_anchor`.

**Fairness.** The Partner API allows 4 requests per second per client. `api::plan::PartnerPlans`
keeps well under it:

1. No operation reads `plan_handle`, so nothing a visitor types starts a call or grants a plan. The
   redirect parameter is data for the web app's plan page only.
2. `billing::sweep::on_app_load` decides per shop (fresh within 5 minutes, billing-cycle and trial
   boundaries, failure backoff from 1 minute to 6 hours). A shop that needs no check costs no call.
3. One call per shop at a time; a second load meanwhile uses the stored plan.
4. Calls across all shops are spaced 334 ms apart (3 a second); a caller that would wait over 2
   seconds uses the stored plan instead of queueing.
5. A failed or malformed answer stores the failure (`consecutive_failures`, `last_attempt_at`) and
   leaves the stored plan in force.

It runs from `getOverview` only (the App Home's first call) and only when `SHOPIFY_PARTNER_ORG_ID`,
`SHOPIFY_PARTNER_API_TOKEN` and `SHOPIFY_APP_GID` are all set (LAUNCH.md section C, row 2); with none
set the api serves stored plans, which are Free until the founder's Partner client exists. Setting
some but not all stops the process at boot.

## Consequences

- Until the Partner client exists no shop can be confirmed on a paid plan; every shop reads as Free.
  Row 4 of section E tracks the live check.
- The background sweep (`in_sweep`) is not scheduled in R1; the 24-hour age limit is enforced when
  the merchant next opens the app. Scheduling it is R2.
- The `db` crate now depends on `billing` for the stored row's type; `billing` stays free of
  database code.
