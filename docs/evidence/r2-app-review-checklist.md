# R2 evidence: the App Review checklist (PLAN §14) against the code

Date: 23 October 2026. Branch `r2-perf-review`. ADR-302 records the method.

## How this was checked

- The nine items of PLAN §14's "App Review checklist (gate for R2)", then every item of Shopify's
  current
  [App requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
  that applies to an embedded Admin app with a theme app extension (read 23 October 2026 through
  the documentation fetcher, because the proxy blocks `shopify.dev` for `curl`; the page lists
  sections 1 to 19 and the cross-cutting listing items 5.A to 5.G, 6 to 8).
- The numbered rules cited below (1.1.1, 1.1.3, 1.2.x, 2.2.x, 2.3.4, 3.2, 4.x, 5.1.x) come from
  [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
  which could not be fetched on 23 October 2026 (the fetcher timed out on that URL). They are
  the numbers read on 17 and 19 October 2026 and recorded in ADR-141, ADR-142 and
  `docs/evidence/ws-5-launch-docs.md`. Where the 23 October checklist page restates a rule, the
  row says so.
- Each row names evidence you can run: a test, a file, or a command. Rows that only the founder
  can complete are **FOUNDER** and have a row in `docs/LAUNCH.md` section C or E.
- Status words: **PASS** (the code meets it now), **FIXED** (it failed in this branch and a fix
  is in the same pull request), **FOUNDER** (needs an account, a live store or a decision).
  No row is FAIL at the end of this branch.

## A. PLAN §14 checklist

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| A1 | GraphQL Admin API only; API version 2026-10 | PASS | The only Admin client is `crates/shopify-admin` (`API_VERSION = "2026-10"`, `lib.rs`; every request goes to `/admin/api/2026-10/graphql.json`, `client.rs`). `grep -rE 'admin/api/[^"]*\.json' crates packages apps` finds nothing but `graphql.json`. Webhooks `api_version = "2026-10"` in `shopify.app.toml`, asserted by `infra/railway/tests/test_shopify_app_config.py`. |
| A2 | Latest App Bridge script in the `<head>` of every document | PASS | `apps/web/src/routes/app/+layout.svelte` puts `<meta name="shopify-api-key">` then `https://cdn.shopify.com/shopifycloud/app-bridge.js` first in the head. New test `apps/web/tests/app-review.spec.ts` "App Bridge is the first script in the head, loaded synchronously, after the api key" (no `async`, `defer` or `type`); `tests/app.spec.ts` checks it in the embedded frame with the content security policy. |
| A3 | Session-token authentication; no separate login for merchants | PASS | `crates/api/tests/shopify_session.rs` (`missing_or_invalid_tokens_answer_401_with_the_retry_header`, `a_token_shopify_calls_stale_answers_401_with_the_retry_header`, `the_first_session_installs_and_later_ones_do_not`); `crates/shopify-auth/tests/lifecycle.rs` (token exchange, expiry, `an_uninstalled_shop_is_reinstalled_on_its_next_session`); `app-screens.spec.ts` "every request to the api carries the session token and none goes unauthenticated". The merchant never sees a login; the passkey sign-in is the separate standalone dashboard for non-Shopify customers (`/dashboard`). |
| A4 | Compliance webhooks implemented; invalid HMAC returns 401 | PASS | `shopify.app.toml` subscribes `customers/data_request`, `customers/redact`, `shop/redact` as `compliance_topics` (and `app/uninstalled`, `shop/update`); `test_shopify_app_config.py` asserts all three exactly once. `crates/api/tests/webhooks.rs` `an_unsigned_or_wrongly_signed_delivery_is_401_and_stores_nothing`, `the_signature_is_checked_before_the_database_is_touched`; handlers `crates/ctl/tests/webhook.rs` (`the_customer_compliance_topics_record_that_nothing_is_held_and_keep_no_details`, `shop_redact_deletes_the_shops_data_and_only_the_shops_data`). Live delivery: LAUNCH.md E rows "Real signed webhook delivery" and "Compliance webhooks". |
| A5 | Plans through Shopify App Pricing; no external payment | PASS | Managed pricing: the app links to `admin.shopify.com/store/<shop>/charges/rampsmith/pricing_plans` (`apps/web/src/lib/app/nav.ts`, `crates/billing/src/shopify.rs`); the app has no payment form and contacts no payment host. New tests in `app-review.spec.ts` ("plans are changed on Shopify's hosted plan page" and "only the app and Shopify are contacted"). Stripe is for non-Shopify customers only (ADR-008, R3). |
| A6 | No theme code injection; app embed only | PASS | No `write_themes` scope and no theme mutation anywhere (`grep -rE 'themeFilesUpsert\|themeCreate\|themeFilesCopy' crates packages apps` finds nothing); `test_shopify_app_config.py` new test `test_no_theme_write_and_no_customer_or_order_scope`; the only storefront code is `extensions/theme-app-ext` (one embed, off by default, 4.7 KB script, `packages/theme-app-ext-test/test/budgets.test.ts`). ADR-004, ADR-141. |
| A7 | Listing copy, screenshots and in-app strings pass `claims-lint` | PASS | `node packages/claims-lint/src/main.ts`: 147 files scanned, no banned claims (covers `listing/**`, `apps/web/messages`, `apps/web/src/**/*.svelte`, theme extension locales). Screenshots hold no text claims beyond app strings; their alt text is checked by `apps/web/src/lib/app/listing.test.ts`. |
| A8 | Demo store, screencast and test credentials prepared for reviewers | FOUNDER | Prepared: `listing/shopify-app-store/reviewer-instructions.md` (steps, scopes, requirements table), `screencast-script.md`. Needs a development store (LAUNCH.md C row 3), the recording on it, and credentials typed into the form: LAUNCH.md E "Review screencast recorded and the reviewer steps run on a development store". |
| A9 | Privacy policy, terms and support contact published | FOUNDER | Drafts marked "attorney review required" in `docs/legal/`; publishing legal text needs the founder (CLAUDE.md). LAUNCH.md C row 13 (legal) and row 10 (domain, support inbox). |

## B. Shopify's App requirements checklist, item by item

| Id | Requirement (paraphrased, read 23 Oct 2026) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | The app is not a prohibited type | PASS | An accessibility scanner and fixer for the Online Store; not among the prohibited categories listed in requirement 1.1 (read 17 Oct, ADR-142). |
| 2.A | Authorize before any other step, including after an uninstall | PASS | Shopify-managed installation with token exchange (ADR-022): the first session after a reinstall exchanges again (`lifecycle.rs` `an_uninstalled_shop_is_reinstalled_on_its_next_session`); `use_legacy_install_flow = false`, asserted by `test_shopify_app_config.py`. |
| 2.B | Request only the scopes the app needs (3.2) | PASS | Ten scopes, exactly PLAN §14's set, each justified in `reviewer-instructions.md`; `test_the_scopes_are_exactly_the_ones_the_plan_justifies`. Note: in this build only `write_files` is exercised by a shipped screen; `write_products`, `write_content` and `write_online_store_navigation` serve the R2 description and page fixes that are not in the build. If those fixes do not ship before submission, drop the three scopes first (LAUNCH.md C row 13). |
| 2.C.1 | No pop-ups for essential flows such as OAuth or charge approval | PASS | `app-review.spec.ts` "moving between screens is client-side: no reload, no frame change, no pop-up"; no `window.open` in `apps/web/src/routes/app`; plan page opens with `target="_top"`. |
| 3.A | Follow the App Design Guidelines | PASS | Polaris web components, `s-app-nav`, `s-page`, `s-section`, banners and empty states (`apps/web/src/routes/app/**`); contextual save bar on the settings form (`data-save-bar`); live checks LAUNCH.md E "App Bridge save bar". |
| 3.B.1 | Charge through Shopify App Pricing | PASS | See A5. |
| 3.B.2 | Upgrade or downgrade without contacting support; charges in history | PASS | The hosted plan page does both; the Compare plans link is on the Overview, Settings and every locked feature (`LockedFeature.svelte`). Live: LAUNCH.md E "The managed pricing page link opens the plan page". |
| 3.B.3 | Enterprise plans in "Description of additional charges" | PASS | None offered; the field is "none" (`listing.md`). |
| 3.C.1 | Chrome cookie behaviour and `SameSite` | PASS | The embedded app sets no cookie (`app-review.spec.ts` "no cookie and no web storage is used"); the only cookie in the web app is the standalone dashboard's, `HttpOnly; Secure; SameSite=Lax` (`apps/web/src/lib/server/dashboard.ts`). |
| 3.C.2 | Re-review when core functionality drifts | PASS | Nothing to do now; `release-verifier` re-checks the build against the submitted listing. |
| 4.A, 4.B | Lighthouse impact of the storefront under 10 points | FOUNDER | Substitute now: the embed adds 4.7 KB of deferred JavaScript, under 2 KB of CSS and no layout shift (`packages/theme-app-ext-test/test/budgets.test.ts`, `browser-layout.test.ts`). Live: Lighthouse on the Home, Product and Collection pages of the demo store with the embed on and off, five runs averaged: LAUNCH.md E "Storefront Lighthouse impact of the app embed". |
| 5 | Create the listing through Shopify App Store distribution | FOUNDER | The founder's Partner account (LAUNCH.md C rows 1 and 13). |
| 9 | Theme app extensions only; no manual code changes (5.1) | PASS | See A6; no code-fix channel in this build (ADR-141). |
| 9.1 | Work in the theme editor; setup instructions with deep links (5.1.3) | FIXED | There were no setup instructions in the app. Settings now has an "Online store" section with the documented deep link `https://<shop>/admin/themes/current/editor?context=apps&activateAppId=<api_key>/accessibility` (`embedActivationUrl`, `nav.ts`; unit tests in `nav.test.ts`; browser test "setup instructions link to the theme editor"). The reviewer steps and the screencast show it. |
| 9.2 | Attribution at most 24 x 24 px | PASS | The embed shows no logo or app name to shoppers: its strings are "Accessibility", "Report an accessibility barrier" and the form (`extensions/theme-app-ext/locales/en.default.json`). |
| 9.3 | No review requests or promotion of other apps in storefront components | PASS | Same strings; `packages/theme-app-ext-test/test/claims.test.ts`. |
| 9.4 | Merchants preview storefront edits before publishing | PASS | The embed changes only when the merchant switches it on in the theme editor, which previews it; no other storefront edit exists in this build. |
| 10.1 | Admin apps use App Bridge so redirects work inside the app | PASS | A2; links carry `shop`, `host` and `embedded` (`nav.ts`, `carriedQuery`). |
| 10.2 | Session tokens; no third-party cookies or local storage; works in Chrome incognito | PASS | A3, 3.C.1 above; the test records every `Storage` call and every `document.cookie` access across all six screens and finds none. |
| 10.3 | Max modal only from merchant actions | PASS | No modal of any kind is used (`grep -rn 's-modal' apps/web/src` finds nothing). |
| 5.A.1 | App name leads with the brand, at most 30 characters, matches the TOML | PASS | "Rampsmith" (9); `shopify.app.toml` `name = "Rampsmith"`. Trademark clearance is the founder's (LAUNCH.md C row 13). |
| 5.A.4 | App icon 1200 x 1200 px, no text | FOUNDER | Needs the brand mark; not produced (`listing.md`, "Feature media, app icon and video"). |
| 5.B.1 | Feature media | FOUNDER | Same. |
| 5.B.2 | Demo development store with instructions | FOUNDER | A8. |
| 5.B.3 | 3 to 6 desktop screenshots at 1600 x 900, one of the UI, alt text, no PII, pricing, reviews or guarantees | PASS | `listing/screenshots/` (6 files); `listing.test.ts` checks count, size and alt text. To retake on the real admin: LAUNCH.md E. |
| 5.B.4 to 5.B.6 | App introduction at most 100, details at most 500, features at most 80 characters | PASS | `listing.md` (98, 467, 59 to 76); claims-lint clean; ADR-141 wording. |
| 5.B.7 | Up to six integrations | PASS | None listed. |
| 5.C | Pricing only in the pricing section; Free plan as a recurring charge | PASS | `listing.md`, "Pricing". |
| 5.D | Translations | PASS | English only, as the interface (`listing.md`). |
| 5.E.1 to 5.E.3 | Categories, privacy policy, subtitle, five search terms | PASS for copy | `listing.md`; the privacy policy URL is FOUNDER (A9). |
| 5.F | Detect store changes with webhooks and notify merchants | PASS | `app/uninstalled`, `shop/update`, `themes/*` and product topics (PLAN §14); `crates/ctl/tests/webhook.rs`. |
| 5.G | Review preparation: instructions, English screencast, valid credentials | FOUNDER | A8. |
| 6 | The app is secure before submission | PASS | `docs/evidence/integration-security-audits-2026-10-19.md`, `r1-integration-audit.md`, `r1-webhooks-reaudit.md`; the `security-auditor` runs again on R2 changes. Encryption (ADR-021), row-level security isolation suite, CSP with per-shop `frame-ancestors` (`apps/web/src/lib/server/headers.test.ts`). |
| 7.1 | Customer data handled properly; privacy policy in the listing | PASS for code | No customer or order scope; compliance topics handled; privacy draft in `docs/legal/`. Publishing: A9. |
| 7.2 | Only supported APIs; none deprecated within 90 days | PASS | A1: version 2026-10 and GraphQL only; `docs/runbooks/shopify-api-version-upgrade.md`. |
| 8 | Support content and a current emergency developer contact | FOUNDER | Help content URL and the emergency contact in the Partner Dashboard: LAUNCH.md C row 13 and `[DOCS URL]` in `listing.md`. |

## Counts

| | Rows | PASS | FIXED | FOUNDER | FAIL |
| --- | --- | --- | --- | --- | --- |
| A. PLAN §14 | 9 | 7 | 0 | 2 | 0 |
| B. Shopify checklist | 36 | 28 | 1 | 7 | 0 |
| Total | 45 | 35 | 1 | 9 | 0 |

("PASS for copy" and "PASS for code" count as PASS; their founder part is carried by A8 and A9.
The FOUNDER rows are A8, A9, 4.A and 4.B (one row), 5, 5.A.4, 5.B.1, 5.B.2, 5.G and 8.)

## What changed in the code because of this checklist

1. Settings gained an "Online store" section with the theme editor deep link for the app embed
   (9.1, requirement 5.1.3): `apps/web/src/lib/app/nav.ts`, `settings/+page.svelte`,
   `messages/en.json`.
2. `app-review.spec.ts` (6 browser tests) pins what a browser can show: App Bridge first in the
   head, no cookie or storage, no reload or pop-up, only the app and Shopify contacted, the
   setup deep link, the hosted plan page.
3. `test_shopify_app_config.py` pins the scope list and the install flow.
4. The listing package was rewritten for the App Store build (no code channel, ADR-141).

## What this does not show

- Nothing here ran in Shopify's real admin: the browser tests use the Polaris shim and a fake
  App Bridge (ADR-094). The founder's live checks are in LAUNCH.md section E.
- App Review applies judgement beyond this list. The two requirements most likely to draw a note
  are 3.2 (the three write scopes the build does not yet use) and 5.1.1 (the optional pull-request
  channel, which is off).
