# ADR-131: Shopify App Pricing plan state through the Partner API

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-4 (`crates/billing`)

## Context

PLAN §4 and §20 say: "Plan state comes from the `plan_handle` redirect parameter, confirmed
through the Partner API's active-subscription query on every app load and in a daily sweep,
because App Pricing sends no plan-change webhooks." The stream brief asked whether the docs
instead point at the Admin API's `currentAppInstallation.activeSubscriptions`.

Read on shopify.dev on 2026-10-17 (curl to shopify.dev is blocked in this sandbox; the pages
were read through the web tool):

- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
  (the old `.../billing/managed-pricing` URL now lands here; the product is "Shopify App
  Pricing (formerly Managed Pricing)").
  - After a merchant selects or confirms a plan, Shopify redirects to the plan's welcome link
    and appends `plan_handle` ("The plan that the merchant is subscribed to") and, for external
    redirect URLs, `shop`. "Use these parameters to confirm the subscription status by querying
    the Partner API when your app handles the redirect." "After April 28, 2026, Shopify App
    Pricing no longer appends charge_id to your redirect URL."
  - "Shopify App Pricing doesn't use webhooks to notify your app of subscription changes."
    `APP_SUBSCRIPTIONS_UPDATE` ended on 28 April 2026 for apps enrolled before April 2026.
  - The status check is the Partner API's `activeSubscription(appId:, shopId:)`, which "returns
    null when the shop doesn't have an active subscription". "Redirect merchants without an
    active subscription: Send them to the hosted plan selection page." The Admin API's
    `currentAppInstallation` is cited only for one-time purchases of apps migrated from the
    Billing API.
  - Plan prices are USD only; up to 8 public plans; a plan change emits `SUBSCRIPTION_UPDATED`;
    a downgrade to a free plan is a scheduled cancellation (`SUBSCRIPTION_CANCELLATION_SCHEDULED`)
    at the end of the billing cycle; pending changes appear in `pendingUpdate`.
  - Hosted plan page: `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`.
- [Redirect to the plan selection page](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page):
  the store handle is the shop domain without `.myshopify.com`; the app handle is the `handle`
  in `shopify.app.toml`; the redirect uses `target: "_top"`. The check runs in the root loader
  for every app route; it fetches the shop GID from the Admin API ("The Partner API needs the
  GID, not the myshopify.com domain"); it throws on throttling or other failures "so the loader
  doesn't redirect a paying user"; and it recommends caching only confirmed subscriptions per
  shop "with a short expiry such as five minutes". The sample reads `SHOPIFY_APP_GID` and
  `SHOPIFY_PARTNER_ORG_ID`. The query "returns both Billing API and Shopify App Pricing
  subscriptions".
- [Active subscription reference](https://shopify.dev/docs/api/partner/latest/active-subscription)
  and [ActiveSubscription](https://shopify.dev/docs/api/partner/latest/objects/ActiveSubscription):
  `activeSubscription(appId: ID!, shopId: ID!): ActiveSubscription` with `shop: ShopReference!`,
  `billingPeriod: AppPricingInterval!` (`EVERY_30_DAYS`, `ANNUAL`), `cancelAtEndOfCycle:
  Boolean!`, `currentBillingCycle: BillingCycle` (null during a trial), `items:
  [SubscriptionItem!]!`, `pendingUpdate: PendingUpdate`, `trialEndsAt: DateTime`. IDs look like
  `gid://shopify/App/1234` and `gid://shopify/Shop/5678`. Errors: "Only public apps can access
  active subscription", "Shop not found"; null when the shop has no active contract. The API
  client needs the "Manage apps" permission. `FlatRatePrice.amount` is `Decimal!`.
- [Partner API 2026-10](https://shopify.dev/docs/api/partner/2026-10): versioned separately from
  the Admin API; 2026-10 is the latest stable version (2027-01 is a release candidate);
  `POST https://partners.shopify.com/{org_id}/api/2026-10/graphql.json` with header
  `X-Shopify-Access-Token`; "four requests per second per Partner API client", throttled
  responses are `{"errors": [{"message": "Too many requests"}]}`; 401 means an invalid client.

So the docs confirm PLAN's mechanism (redirect parameter plus the Partner API, not the Admin
API). They add details PLAN lacks: the Partner API's own version, its organization-wide rate
limit, the shop and app GIDs it needs, the end of `charge_id`, and Shopify's own guidance on
caching and failure handling.

## Decision

1. `billing::partner_api` holds the operation as a constant (`ACTIVE_SUBSCRIPTION_QUERY`, the
   documented field names, trimmed to what plan state needs), the request builder for
   `PARTNER_API_VERSION = "2026-10"`, a typed parser tested against fixtures copied from the
   documented response shapes, and `PartnerTransport`, an injectable trait the binaries
   implement with `reqwest`. The token is a `secrecy::SecretString` in `PartnerCredentials`
   and `PartnerRequest`; tests prove it never appears in `Debug` or error output.
2. The `plan_handle` parameter is unauthenticated (anyone can type the URL), so it is trusted
   on its own only for `free`, which grants nothing paid. A paid plan counts only once the
   Partner API returns it. A redirect naming a paid plan that the API does not yet show leaves
   the merchant on an "awaiting confirmation" screen with a re-check, never on the paid plan.
3. `billing::reconcile::reconcile(stored, redirect, answer, now)` is a pure state machine
   returning the new state, events (`Subscribed`, `Upgraded`, `Downgraded`, `Cancelled`,
   `NoActivePlan`, `IntervalChanged`, `CancellationScheduled`, `CancellationWithdrawn`,
   `ChangeScheduled`, `UnrecognizedPlan`, `RedirectNotConfirmed`, `ConfirmationFailed`, ...)
   and an action: continue, send the merchant to the plan page, or await confirmation.
   - A Partner API failure never changes a stored plan and never redirects a shop that has
     one (Shopify's "doesn't redirect a paying user").
   - `null` after a paid plan whose cancellation or downgrade to Free was scheduled becomes
     Free; `null` after any other paid plan is a cancellation and sends the merchant to the plan
     page. `null` for a shop that chose Free stays Free (Shopify does not document whether a
     free plan has a subscription, so both cases are handled).
   - The plan is the subscription item whose `handle` is a Rampsmith plan handle. An unknown
     handle (for example a private or test plan) gets Free entitlements, no redirect, and an
     `UnrecognizedPlan` event for operators.
   - The state carries the usage anchor for monthly alt-text windows (ADR-133).
4. `billing::sweep` decides when to call the API:
   - on app load: always when a `plan_handle` parameter is present or no plan is confirmed
     (a "no plan" answer is never cached); otherwise when the last confirmation is at least
     5 minutes old, or a known boundary (cycle end, trial end) has passed since it;
   - in the sweep: when the last confirmation is at least 24 hours old or a boundary has
     passed; the scheduler should evaluate it hourly so shops spread across the day;
   - after a failure, retries back off from 1 minute, doubling to at most 6 hours.
   The caller's rate limiter keeps all Partner API calls under `MAX_REQUESTS_PER_SECOND` (4),
   shared by every shop in the organization.
5. Assumption with a live check: the subscription item `handle` equals the plan handle set in
   the Partner Dashboard (Shopify's example item handle is `pro_plan`, description "Pro plan").
   The founder's Partner account is needed to confirm it on a development store; the check
   goes in LAUNCH.md section E (see Consequences).

## Plan correction

PLAN §4, the Shopify App Pricing row. Replace its evidence link and design decision with:

> [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) |
> Use Shopify App Pricing. Plan state comes from the `plan_handle` redirect parameter plus the
> Partner API's `activeSubscription` query (section 20, ADR-131).

PLAN §7, "Platform APIs and models" table. Add a row after the Admin GraphQL API:

> | Shopify Partner GraphQL API | 2026-10 (plan state; 4 requests per second per client, ADR-131) |

PLAN §20, "Billing mechanics", first bullet. Replace it with:

> - **Shopify customers:** plans live in the Partner Dashboard under Shopify App Pricing, one
>   handle per plan (`free`, `starter`, `growth`, `pro`) with monthly and yearly prices. A shop
>   with no active plan is sent to Shopify's hosted plan page,
>   `https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans`, opened
>   in the top frame. App Pricing sends no plan-change webhooks and no longer appends
>   `charge_id`, so plan state comes from the `plan_handle` redirect parameter, confirmed through
>   the Partner API's `activeSubscription(appId, shopId)` query (version 2026-10, "Manage apps"
>   permission, IDs `gid://shopify/App/…` and `gid://shopify/Shop/…`). The redirect parameter
>   alone never grants a paid plan. The app confirms on every app load unless a plan was
>   confirmed in the last 5 minutes, always when a `plan_handle` arrives or no plan is
>   confirmed, after each known billing-cycle or trial boundary, and in a sweep that re-confirms
>   every installed shop at least daily, all under the Partner API's limit of four requests per
>   second per client. A Partner API failure keeps the stored plan and never redirects a paying
>   merchant ([Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing),
>   [plan selection page](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page),
>   [activeSubscription](https://shopify.dev/docs/api/partner/latest/active-subscription), ADR-131).

PLAN §9, `shopify_shops`. Add a column (the Partner API needs the shop GID, which the Admin API
returns as `shop { id }` and which the table does not hold today):

> `shop_gid text unique check (shop_gid ~ '^gid://shopify/Shop/[0-9]+$'),  -- Partner API shopId`

## Consequences

- Outside WS-4's paths, for the integrator:
  - a migration adding `shopify_shops.shop_gid` (filled from the Admin API's `shop { id }` at
    install) and a `subscriptions` row per tenant holding the `BillingState` fields
    (`standing`, `plan`, `billing_interval`, `cancel_at_end_of_cycle`, `trial_ends_at`,
    `cycle_start`, `cycle_end`, `pending_plan`, `pending_interval`, `usage_anchor_at`,
    `last_confirmed_at`, `last_attempt_at`, `consecutive_failures`);
  - LAUNCH.md section C row 2 also needs `SHOPIFY_APP_GID` (`gid://shopify/App/<id>`, the
    Partner API `appId`), and the app handle from `shopify.app.toml` must reach the API as
    configuration;
  - a LAUNCH.md section E row: "Plan state on a development store: select each plan on the
    hosted page; the redirect carries `plan_handle`; `activeSubscription` returns an item whose
    handle is that plan handle; selecting Free and cancelling behave as ADR-131 models", inputs
    C1 to C3, substitute test `cargo test -p rampsmith-billing` (recorded fixtures);
  - the `api` root route calls `sweep::on_app_load`, then the Partner API through a `reqwest`
    transport behind a process-wide limiter, then `reconcile`, then persists the state and the
    events in the audit log; `ctl` runs `sweep::in_sweep` hourly over installed shops.
- If Shopify later documents a free plan's `activeSubscription` shape or adds plan-change
  webhooks, `reconcile` gains a case; the stored state does not change shape.

## Rejected alternatives

- Admin API `currentAppInstallation.activeSubscriptions`: the App Pricing docs direct apps to
  the Partner API; a community thread reports localized plan names and null `planHandle` values
  there.
- Trusting `plan_handle` alone: a merchant could type `?plan_handle=pro`.
- Calling the Partner API on literally every page load: the four-requests-per-second limit is
  shared by every shop in the organization, and Shopify's own sample caches confirmed
  subscriptions for about five minutes.
- Redirecting to the plan page when the Partner API fails: would lock paying merchants out
  during a Shopify incident.
