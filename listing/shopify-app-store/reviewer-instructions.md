# Testing instructions for Shopify App Review (draft)

Draft for the founder, to paste into the "testing instructions" part of the app submission form.
Nothing here is submitted. Updated 23 October 2026 for the App Store build: **the code-fix
channel is off** (ADR-141), so there is no Code screen, no GitHub connection and no theme to
download. Every step below runs in the App Store build, and each was exercised against the typed
fake api by the tests named in the last column of the table at the end. Before submission the
founder runs every step once on a development store with the real admin (LAUNCH.md section E).

Shopify's rules for this text: include credentials that are valid and "grant full access to the
app's complete feature set" (requirements 4.5.4 and 4.5.5), and a screencast in English or with
English subtitles (4.5.3). See
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).

**Credentials never go in this file.** The founder types them into the submission form only.

---

## What Rampsmith does

Rampsmith runs automated WCAG 2.2 AA accessibility checks on the merchant's storefront, ranks the
findings, and lets the merchant approve fixes to store data (product image alt text) with
one-click undo. It keeps a dated record of every finding, fix, approval and verification scan, and
generates an accessibility statement the merchant can edit and publish.

## How Rampsmith treats the theme (requirements 5.1.1 and 1.1.3)

- Rampsmith never creates, changes or deletes theme files. It requests `read_themes` only, to
  locate where a finding comes from, and no `write_themes`. A test fails the build if
  `shopify.app.toml` asks for another scope.
- The only storefront change the app makes is its theme app extension: one app embed, off by
  default, that adds an "Accessibility" footer link to the merchant's statement and an optional
  barrier-report form. The merchant turns it on in the theme editor (the app links there). It is
  under 5 KB of deferred JavaScript. Uninstalling the app leaves nothing in the theme.
- Rampsmith offers no theme download, no code snippet to paste and no pull request in this
  build, so requirement 1.1.3 ("Your app must not allow merchants to download themes") and the
  "no code changes to the theme" sentence of 5.1.1 have nothing to apply to.

## Test store and access

| Item | Value |
| --- | --- |
| Demo store | `[DEMO STORE URL]` |
| Storefront password | In the submission form |
| Plans | Paid plans are marked "Free for partners and developers", so a review store can use every plan at no charge `[Founder: confirm in FOUNDER_SETUP.md step 5]` |
| Support contact during review | `[SUPPORT EMAIL]`; emergency developer contact set in the Partner Dashboard |

## Steps to test

1. **Install.** Install Rampsmith from the listing on a development store. Shopify-managed
   installation grants the scopes below; the app opens inside the Shopify admin with no separate
   login and no pop-up. The first screen says "Connecting to your store" for a moment, then
   shows the Overview.
2. **First scan.** On the Overview, choose Start a scan. The scan checks the home, collection,
   product, cart, search, login, page and blog article templates, and opens the main menu, the
   cart drawer, a variant picker and the first pop-up. Progress appears, then the Overview shows
   the latest scan, open issues by impact, the pass rate of the automated checks and the next
   scan. Pages behind a bot challenge are reported as blocked; Rampsmith does not try to get
   around the challenge.
3. **Issues.** Open Issues. Each row shows its WCAG 2.2 success criterion, how much it affects
   shoppers, whether it is on the path to purchase and whether it has a fix. Filter by impact,
   where it was found and whether it has a fix. Open one: it shows a plain-language explanation,
   the criterion with a link to W3C's explanation, the pages and elements it appears on, and its
   fixes. The page says automated checks find only part of all barriers.
4. **Approve and undo a data fix.** Open Review fixes. Pick an AI-drafted alt text for a product
   image, choose Edit, change a word and Save, then Approve. Rampsmith writes it with Shopify's
   `fileUpdate`, re-checks the product page and moves the change to Applied changes. Choose
   Undo: the previous alt text returns. Every button works with the keyboard alone; focus and a
   spoken status message follow each action.
5. **Remediation log and statement.** Open Remediation log: every change, who approved it and how
   it was verified; Download CSV and Download JSON export it. Open Accessibility statement: fill
   in the business name and an email, watch the preview update, and Save a version. The statement
   says what was and was not checked and never claims that the store meets a standard.
6. **Storefront link (theme app extension).** Open Settings. Under "Online store", choose "Open
   the theme editor": it opens App embeds with "Accessibility statement" ready to switch on.
   Switch it on, Save, then open the storefront: the footer shows an "Accessibility" link to the
   statement once one is published. Switch it off: nothing remains. (The link is the deep link
   Shopify documents for app embeds.)
7. **Plans.** Open Settings or the Overview and choose Compare plans: the app opens Shopify's
   hosted plan page, where the plan can be upgraded or downgraded without contacting support
   (requirement 1.2.3). Plan-gated features are shown, labelled and disabled on lower plans; the
   app takes no payment details itself.
8. **Settings.** Change the weekly rescan (paid plans), the notification email and the monthly
   AI budget, and enter the storefront password for password-protected stores (it is stored
   encrypted and never shown again). Save and Discard act on the form.
9. **Uninstall and reinstall.** Uninstall: Rampsmith stops scanning and emails the shop owner an
   export of the record. Reinstall: authorization runs again (requirement 2.3.4) and the app
   opens as new.

## Access scopes and why each is needed

From PLAN §14 (requirement 3.2: request only what is necessary).

| Scope | Why |
| --- | --- |
| `read_products`, `write_products` | Check product data and write the product changes the merchant approves |
| `read_files`, `write_files` | Read image alt text; write approved alt text with `fileUpdate` |
| `read_themes` | Read theme files to locate findings; nothing is written |
| `read_content`, `write_content` | Check pages, blogs and articles |
| `read_online_store_navigation`, `write_online_store_navigation` | Check menu labels |
| `read_locales` | Detect store languages for translated labels and statements |

Rampsmith requests no customer or order scopes and opts out of protected customer data. In this
build the only writes are approved alt text; the other write scopes are for the fix types in
PLAN §5 R2 that are not in this build, and the founder may remove them from the submission until
then (requirement 3.2): `[Founder: decide before running shopify app deploy]`.

## Platform requirements the app meets

Evidence is in `docs/evidence/r2-app-review-checklist.md`.

| Requirement | How | Evidence |
| --- | --- | --- |
| Mandatory privacy webhooks: `customers/data_request`, `customers/redact`, `shop/redact` | Subscribed in the app configuration; HMAC verified on the raw body, `401` on an invalid signature; each handled within 30 days | `crates/api/tests/webhooks.rs`, `crates/ctl/tests/webhook.rs`, `infra/railway/tests/test_shopify_app_config.py` |
| Session tokens, no third-party cookies or local storage (1.1.1, 10.2) | App Bridge session tokens verified on the server; the app sets no cookie and uses no web storage | `crates/api/tests/shopify_session.rs`, `apps/web/tests/app-review.spec.ts` |
| Latest App Bridge script first in `<head>` (2.2.3) | Loaded from Shopify's CDN, synchronously, after the API key meta tag | `apps/web/tests/app-review.spec.ts`, `app.spec.ts` |
| GraphQL Admin API only (2.2.4) | API version 2026-10 | `crates/shopify-admin` |
| Shopify App Pricing for all charges (1.2.1) | Four plans on Shopify's hosted page; no external payment | `crates/billing`, `app-review.spec.ts` |
| Theme changes only through a theme app extension (5.1.1) | One app embed, off by default; no theme file is written | `packages/theme-app-ext-test`, `test_shopify_app_config.py` |
| Merchants are directed to the Shopify Theme Store; the app lets no merchant download a theme (1.1.3) | No theme download exists in this build | ADR-141 |
| Accessible interface | WCAG 2.2 A and AA axe run on every screen, and keyboard flows | `app-axe.spec.ts`, `app-keyboard.spec.ts` |

## Known limitations at submission

- Pages behind a bot challenge are reported as blocked and never retried around the challenge.
- Automated checks find only part of all barriers; the app says so on the Overview, the Issues
  list and the statement.
- `[Founder or builder: add anything a reviewer might hit on the demo store.]`
