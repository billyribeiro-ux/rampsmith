# Testing instructions for Shopify App Review (draft)

Draft for the founder, to paste into the "testing instructions" part of the app submission
form. Nothing here is submitted. Each step carries its build status: **Not built yet (R*n*)**
means the step depends on a part of Rampsmith that does not exist at the date of this draft
(17 October 2026); *n* is the release in PLAN §5 that builds it. Before submission, every flag
must be gone and every step must have been run on a development store.

Shopify's rules for this text: include credentials that are valid and "grant full access to the
app's complete feature set" (requirements 4.5.4 and 4.5.5), and a screencast in English or with
English subtitles (4.5.3). See
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).

**Credentials never go in this file.** The founder types them into the submission form only.

---

## What Rampsmith does

Rampsmith runs automated WCAG 2.2 AA accessibility checks on the merchant's storefront, ranks
the findings, and lets the merchant approve fixes to store data (image alt text, product
descriptions, pages and menus) with one-click undo. It keeps a dated record of every finding,
fix, approval and verification scan, and generates an accessibility statement the merchant can
edit and publish.

## How Rampsmith treats the theme (requirements 5.1.1 and 1.1.3)

- Rampsmith never creates, changes or deletes theme files. It reads theme files only, with
  `read_themes`, to locate where a finding comes from.
- The only storefront change the app makes is its theme app extension: one app embed, off by
  default, that adds an "Accessibility" footer link to the merchant's statement and an optional
  barrier-report form. Uninstalling the app leaves nothing in the theme.
- For findings that sit in theme code, Rampsmith prepares a change for the merchant's own
  developer: a pull request on a GitHub repository the merchant connects, or a copy of the theme
  with the changes, which the developer can review and install as an unpublished theme.
  Rampsmith never merges, never installs and never publishes a theme. The app's scanning, data
  fixes, record and statement work without these optional handoffs.
- Rampsmith is not a way to obtain themes. Requirement 1.1.3 says "Your app must not allow
  merchants to download themes" and "Themes can only be installed via the Shopify Theme Store".
  The theme copy in step 8 is a fixed copy of the merchant's own theme, not a theme from
  elsewhere, but it is a theme the merchant downloads, so it is the first thing to remove if the
  founder decides 1.1.3 applies.
- `[Founder: confirm this section after the ADR-141 decision. If the App Store build hides the
  code handoffs, delete the third and fourth points and steps 7 and 8. If only the theme copy
  goes, delete the fourth point, the theme-copy half of the third point and step 8, and keep
  step 7.]`

## Test store and access

| Item | Value |
| --- | --- |
| Demo store | `[DEMO STORE URL]` |
| Storefront password | In the submission form |
| GitHub test account with access to the test theme repository (step 7) | In the submission form |
| Plans | Paid plans are marked "Free for partners and developers", so a review store can use every plan at no charge `[Founder: confirm in FOUNDER_SETUP.md step 5]` |
| Support contact during review | `[SUPPORT EMAIL]`; emergency developer contact set in the Partner Dashboard |

## Steps to test

1. **Install.** Install Rampsmith from the listing on a development store. Shopify-managed
   installation grants the scopes below; the app opens inside the Shopify admin with no separate
   login. **Not built yet (R0 step 7, R1).**
2. **First scan.** On the home screen, start a scan. It checks the home, collection, product,
   cart, search, login, page and blog article
   templates, and opens the main menu, the cart drawer, a variant picker and the first pop-up.
   The home screen shows the automated checks passed, open findings by impact, and the last and
   next scan. **Not built yet (R1).**
3. **Findings.** Open Findings. Each finding shows its WCAG 2.2 success criterion, a
   plain-language explanation, an evidence screenshot and the templates it affects. The list
   states which criteria need a human review. **Not built yet (R1).**
4. **Approve and undo a data fix.** Open Fixes, pick an AI-drafted alt-text proposal for a
   product image, edit it if you like, and approve it. Rampsmith writes it with Shopify's
   `fileUpdate`, re-checks the product page and marks the finding fixed. Choose Undo: the
   previous alt text returns. **Not built yet (R1).**
5. **Description fix (Growth plan).** Approve a proposed correction to a product description's
   heading levels or link text; check the product page; undo it. **Not built yet (R2).**
6. **Remediation record and statement.** Open the record and export it; open Statement, edit the
   generated accessibility statement and save a version. In the theme editor, turn on the
   Rampsmith app embed and check the footer link. **Not built yet (R1).**
7. **Pull request (Growth plan, optional handoff).** Open Code, connect the GitHub test account
   and choose the test theme repository and branch. Approve a theme code fix: Rampsmith opens a
   pull request with one commit per fix and a "Rampsmith verification" check. It does not merge
   it. **Not built yet (R2).**
8. **Theme copy (Starter plan, optional handoff; the step requirement 1.1.3 puts at risk, ADR-141).** In Code, download the theme copy with fixes.
   After it is uploaded as an unpublished theme, Rampsmith scans its preview and shows the result
   before anyone publishes. **Not built yet (R2).**
9. **Plans.** Open Plan: the app redirects to Shopify's hosted plan page, where the plan can be
   upgraded or downgraded without contacting support (requirement 1.2.3). Plan-gated features are
   shown, labelled and disabled on lower plans. **Not built yet (R2).**
10. **Settings.** Change the scan schedule, the notification email and the monthly AI budget, and
    enter the storefront password for password-protected stores. **Not built yet (R1).**
11. **Uninstall and reinstall.** Uninstall: Rampsmith stops scanning and emails the shop owner a
    link to export the record. Reinstall: authorization runs again (requirement 2.3.4).
    **Not built yet (R2).**

## Access scopes and why each is needed

From PLAN §14 (requirement 3.2: request only what is necessary).

| Scope | Why |
| --- | --- |
| `read_products`, `write_products` | Check and correct product descriptions the merchant approves |
| `read_files`, `write_files` | Read image alt text; write approved alt text with `fileUpdate` |
| `read_themes` | Read theme files to locate findings and prepare code changes; nothing is written |
| `read_content`, `write_content` | Check and correct pages, blogs and articles the merchant approves |
| `read_online_store_navigation`, `write_online_store_navigation` | Check and correct menu labels |
| `read_locales` | Detect store languages for translated labels and statements |

Rampsmith requests no customer or order scopes and opts out of protected customer data.

## Platform requirements the app meets

| Requirement | How | Status |
| --- | --- | --- |
| Mandatory privacy webhooks: `customers/data_request`, `customers/redact`, `shop/redact` | Subscribed in the app configuration; HMAC verified on the raw body, `401` on an invalid signature; each request completed within 30 days | Not built yet (R2) |
| Session tokens, no third-party cookies or local storage (1.1.1) | App Bridge session tokens verified on the server | Not built yet (R0 step 8) |
| Latest App Bridge script first in `<head>` (2.2.3) | Loaded from Shopify's CDN | Not built yet (R0 step 8) |
| GraphQL Admin API only (2.2.4) | API version 2026-10 | Not built yet (R0 step 7) |
| Shopify App Pricing for all charges (1.2.1) | Four plans; no external payment | Not built yet (R2) |
| Theme changes only through a theme app extension (5.1.1) | One app embed, off by default | Not built yet (R1) |
| Merchants are directed to the Shopify Theme Store; the app lets no merchant download a theme (1.1.3) | Pending the founder's ADR-141 decision: the theme copy (step 8) is off in the App Store build unless he decides it may stay | Decision open |

## Known limitations at submission

`[Founder or builder: list anything a reviewer might hit, such as pages behind a bot challenge,
which Rampsmith reports as blocked and never tries to get around.]`
