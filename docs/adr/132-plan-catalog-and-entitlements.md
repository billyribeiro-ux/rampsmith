# ADR-132: Plan catalog and the single entitlements function

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-4 (`crates/billing`)

## Context

PLAN §20 defines four Shopify plans and requires that "one Rust function maps a tenant's plan
to its limits", read by the scheduler, the API and the UI alike, so that a limit cannot differ
between enforcement and display. PLAN §11 adds the render sampling per plan. The pricing in
PLAN §20 is founder-approved as written (17 October 2026) and must not change here.

Built for Shopify requirement 4.3.7, "Label and disable premium features", read on
<https://shopify.dev/docs/apps/launch/built-for-shopify/requirements> on 2026-10-17, says:
"Features that are gated by a particular plan, must be disabled (both visually and
functionally) and clearly indicated." Its listed rejection reasons include "When an app offers
multiple tiers and it is not obvious which specific tier is required to unlock a specific
feature." PLAN §20 cites this as "Built for Shopify 4.1", which is not the current number.

## Decision

1. `billing::Plan` is `Free < Starter < Growth < Pro` (declaration order is tier order) with the
   architect-fixed handles `free`, `starter`, `growth`, `pro`. The same handle is configured in
   the Partner Dashboard for both the monthly and the yearly price of a plan; the Partner API
   reports the interval separately (`EVERY_30_DAYS` or `ANNUAL`).
2. Prices are integer USD cents (PLAN §8), exactly PLAN §20: 0/0, 7,900/79,000, 19,900/199,000,
   49,900/499,000 (monthly/yearly).
3. `billing::entitlements(plan) -> Entitlements` is the only source of limits. `Entitlements`
   has private fields, so no other code can build a second table. It carries:
   render cadence (monthly, weekly, daily, daily); render sampling (home page plus 5 pages;
   3 per template; 10 per template; 25 per template variant); alt-text drafts (25 lifetime;
   2,000, 10,000 and 50,000 per monthly window, ADR-133); image alt-text fixes (Free: the first
   25 images; paid plans: all); and the feature set.
4. Features are the PLAN §20 fix-channel cells, cumulative by tier: Free `data_fixes`;
   Starter adds `core_recipes` and `github_pull_requests` (ADR-141 retired `theme_package` on
   19 October 2026); Growth adds `every_recipe`, `description_rewrites`, `regression_alerts`; Pro adds
   `ai_widget_proposals`, `multi_language_statements`, `priority_queue`. UI text for them lives
   in the web app's message catalogs (PLAN §8); the crate exposes only stable keys.
5. Gates are derived from `entitlements`, never from a second table: `feature_gate(plan,
   feature)` returns `Allowed`, or `Locked { unlocked_by }` naming the lowest plan that allows
   it, so the UI can show every feature, disabled and labelled with the exact tier (BFS 4.3.7).
   `image_fix_gate` does the same for Free's 25-image limit.
6. Page budget: `RenderSampling::page_budget(templates)` is the most pages one render scan may
   load. Each paid plan's budget is also floored at Free's budget (home page and 5 pages), so a
   store with a single large template does not get fewer pages on Starter (3 samples) than on
   Free (6 pages). This keeps PLAN §20's cumulative reading ("Adds ...") true for every store,
   and is proven by a property test over generated store shapes.
7. Free's alt-text allowance is "25, once": it counts every draft the shop has ever received,
   on any plan, so returning to Free after a paid plan does not grant another 25 (ADR-133).

## Plan correction

PLAN §20, the sentence after the plan table. Replace

> Plan-gated features are shown, labelled and visually disabled, as Built for Shopify 4.1 requires.

with

> Plan-gated features are shown, disabled both visually and functionally, and labelled with the
> lowest plan that unlocks them, as Built for Shopify requirement 4.3.7 requires
> ([Built for Shopify](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)).
> `billing::feature_gate` returns that plan.

PLAN §14, "The UI follows Built for Shopify 4.1": the design requirements are now section 4
("4.1 Familiar", "4.2 Helpful", "4.3 User-friendly"); the integrator should re-read that
section when the web app is built rather than cite a single number.

## Consequences

- The scheduler, API and UI import one function; a limit change is one edit plus the
  table test in `crates/billing/tests/plan_table.rs`, which transcribes every PLAN §20 cell.
- Property tests (`tests/monotonic.rs`) fail if any change makes a higher plan give less.
- `Plan` lives in `billing`, not `domain`, because WS-4 may not edit `crates/domain`. When a
  `subscriptions` table with a `plan` check constraint is added, the integrator may move `Plan`
  to `domain` beside the other stored enums and re-export it from `billing`.

## Rejected alternatives

- A per-feature table beside the entitlements: two sources of truth, which PLAN §20 forbids.
- Hiding locked features: BFS 4.3.7 requires them visible, disabled and labelled.
- Literal per-template sampling without the Free floor: a higher plan could render fewer pages
  than Free on a one-template store.
