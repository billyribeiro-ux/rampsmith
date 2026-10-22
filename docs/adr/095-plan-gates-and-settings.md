# ADR-095: Plan gates and settings in the App Home

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-091, PLAN §20 (plans), Built for Shopify 4.1
- Lane: R1 lane C (`routes/app/settings`, `lib/app/components/LockedFeature.svelte`)

## Decision

1. **Gates come from the api.** `Entitlements.features` is `billing::Gate` per feature
   (`allowed`, `locked` with the lowest plan that unlocks it, or `unavailable`). The app never
   derives a gate from the plan name.
2. **Locked features are shown, labelled and visually disabled**, with the plan that unlocks
   them and a link to the managed pricing page
   (`admin.shopify.com/store/<handle>/charges/rampsmith/pricing_plans`). The control is
   disabled, not hidden. The weekly-rescan switch is disabled on a plan whose cadence is monthly.
3. **Settings keys**: `weekly_rescan`, `notification_email`, `alt_text_max_characters` (40 to
   300), `ai_budget_micro_usd` (0 to the plan's ceiling, typed in dollars), `storefront_password`
   (write-only: the api answers only `storefront_password_set`). The form validates before it
   sends and shows the api's field errors if it still refuses.
4. **Save bar.** The form uses `data-save-bar` while it has unsaved changes. Where
   `shopify.saveBar` is absent (tests, older hosts) it shows its own Save and Discard buttons.

## Consequences

Changing a plan's features is an api change only. The password never appears in a response,
a log or a test fixture.
