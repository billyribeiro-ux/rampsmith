# Shopify App Store listing: Rampsmith (draft)

Draft for the founder. Nothing here is submitted or published. The founder submits the app
(LAUNCH.md section E).

The three listing files are `listing.md`, `reviewer-instructions.md` and `screencast-script.md` in
this folder. `claims-lint` scans every file here through its `listing/**/*` pattern and skips the
folder itself (the fix for its earlier `EISDIR` stop is on `r0-foundations`).

## Rules this copy follows

- Field limits from Shopify's [Best practices for apps in the Shopify App Store](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices),
  read on 17 October 2026: app name 30 characters, app introduction 100, app details 500, each
  feature 80, up to 5 search terms, screenshots 1600 × 900 with alt text. The pages read state no
  limit for the app card subtitle; the submission form's counter decides.
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements):
  no statistics or data in listing content or the subtitle (4.3.3, 4.4.1), no "the first", "the
  best" or "the only" (4.3.3), pricing only in the pricing section (4.2), no reviews or
  testimonials outside their fields (4.3.6), only languages the app's interface supports (4.3.2).
- PLAN §3 claims policy, enforced by `claims-lint` on this folder.
- ADR-141: the copy never says Rampsmith edits a merchant's theme. Code fixes are described as
  prepared for the merchant's developer.
- Character counts below were computed with the script recorded in
  `docs/evidence/ws-5-launch-docs.md`.

## Build status

Every feature below is specified for the public launch (PLAN §5, R1 and R2) and **none is built
yet**. The copy may be used only once each line is true in the running app; the
`release-verifier` checks this before submission.

| Copy line | PLAN release | Built |
| --- | --- | --- |
| Scans across page types and interactive states | R1 | No |
| Ranked findings with plain-language explanations | R1 | No |
| AI-drafted alt text with approve, edit and undo | R1 | No |
| Corrected headings and link text in descriptions and pages | R2 (Growth plan) | No |
| Pull requests for the merchant's developer | R2 (Growth plan); App Review risk (5.1.1), ADR-141 | No |
| Patched theme package (pricing section only) | R2 (Starter plan); App Review risk (5.1.1 and 1.1.3), ADR-141 | No |
| Remediation record | R1 | No |
| Accessibility statement generator | R1 | No |
| Scheduled rescans and regression alerts | R1 (weekly), R2 (daily, alerts) | No |
| Theme app embed: footer link and barrier-report form | R1 | No |

---

## App name

Limit 30 characters. Trademark clearance comes first (FOUNDER_SETUP.md step 1). The name must
match the app configuration file (requirement 4.1.1).

> Rampsmith

Count: 9 / 30.

## App card subtitle

No limit stated on the pages read; kept short.

> Accessibility fixes at the source, approved by you

Count: 50.

## App introduction

Limit 100 characters.

> Find accessibility barriers in your store and fix them in your own store data, with your approval.

Count: 98 / 100.

## App details

Limit 500 characters.

> Rampsmith checks your storefront against automated WCAG 2.2 AA tests, on key pages and in menus, cart drawers and pop-ups. Each finding is ranked by its effect on shoppers and explained in plain language. Approve AI-drafted alt text and fixes to descriptions, pages and menus, each with one-click undo. Fixes in theme code are prepared for your developer to review. Keep a dated record of every fix. Automated checks cannot find every barrier, so Rampsmith lists what needs a human review.

Count: 489 / 500.

## Feature list

Limit 80 characters each.

1. > Scans key pages plus menus, cart drawers, variant pickers and pop-ups

   Count: 69 / 80.

2. > Ranks findings by their effect on shoppers, in plain language

   Count: 61 / 80.

3. > Drafts alt text with AI for you to approve, edit or undo in one click

   Count: 69 / 80.

4. > Corrects headings and link text in descriptions and pages after you approve

   Count: 75 / 80.

5. > Prepares theme code fixes as pull requests for your developer to review

   Count: 71 / 80.

6. > Keeps a dated record of every finding, fix, approval and verification scan

   Count: 74 / 80.

7. > Generates an accessibility statement that lists what automation cannot check

   Count: 76 / 80.

8. > Rescans on a schedule and flags new barriers after theme or product changes

   Count: 75 / 80.

9. > No overlay or toolbar: fixes change your store's own content

   Count: 60 / 80.

If ADR-141's decision removes the code channels from the App Store build, drop feature 5 and the
sentence "Fixes in theme code are prepared for your developer to review." from the app details.

## Pricing

Billing method: recurring charge, with the Free plan marked as free (Shopify best practices,
"Pricing details"). Prices are PLAN §20, approved by the founder on 17 October 2026, in US
dollars through Shopify App Pricing. Plan handles and the steps to create them are in
`docs/FOUNDER_SETUP.md`, step 5.

| Plan (handle) | Monthly | Yearly |
| --- | --- | --- |
| Free (`free`) | $0 | $0 |
| Starter (`starter`) | $79 | $790 |
| Growth (`growth`) | $199 | $1,990 |
| Pro (`pro`) | $499 | $4,990 |

Plan features, as entered in "Top features":

- **Free:** monthly scan of the home page and 5 pages; data fixes and alt-text drafts for the
  first 25 images, once.
- **Starter:** weekly scans with 3 sample pages per template; data fixes; patched theme package
  with the 6 core fix recipes; 2,000 alt-text drafts a month.
- **Growth:** daily scans with 10 sample pages per template; adds GitHub pull requests, every fix
  recipe, description rewrites and regression alerts; 10,000 alt-text drafts a month.
- **Pro:** daily scans of every template variant with 25 samples each; adds AI proposals for
  custom widgets, multi-language statements and the priority queue; 50,000 alt-text drafts a
  month.

Description of additional charges: none.

## Search terms

Up to 5.

1. accessibility
2. WCAG
3. alt text
4. accessibility statement
5. screen reader

## Integrations

Up to 6. GitHub (pull requests to a connected theme repository).

## Languages

English only at launch (PLAN §8: English ships first). Requirement 4.3.2 allows listing only
languages the app's interface supports.

## Geographic requirements and API access

Requirement 4.3.8 asks listings to state specific API permissions. Draft text for that field:

> Rampsmith reads products, files, pages, blogs, menus, themes and store languages, and writes
> only the product, file, page, blog and menu changes you approve. It never writes theme files
> and requests no customer or order data.

Scopes and their reasons are PLAN §14 and `reviewer-instructions.md`.

## Links

| Field | Value |
| --- | --- |
| Privacy policy | `https://[DOMAIN]/privacy` (draft in `docs/legal/privacy-policy.md`, needs attorney review and founder approval) |
| Support | `[SUPPORT URL]` and `[SUPPORT EMAIL]` |
| FAQ or documentation | `[DOCS URL]` |
| Demo store | `[DEMO STORE URL]`: a development store page that shows a finding and its fix |

## Media

Out of this draft's scope; captured from the running app later. Requirements: app icon 1200 ×
1200 JPEG or PNG without text or Shopify trademarks; feature media 1600 × 900, a static image or a
2 to 3 minute video with screencasts at most 25% of it; 3 to 6 desktop screenshots at 1600 × 900,
at least one of the app's interface, cropped of browser chrome, each with alt text and no pricing,
reviews or outcome promises (requirements 4.2.2, 4.3.4, 4.4.3 to 4.4.5).
