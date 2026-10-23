# Shopify App Store listing: Rampsmith (draft)

Draft for the founder. Nothing here is submitted or published. The founder submits the app
(LAUNCH.md section E). Updated 23 October 2026 for the App Store build: ADR-141's decision is
applied (no code-fix channel, no patched theme package), and every line is checked against the
running app (see "Build status").

The listing files are `listing.md`, `reviewer-instructions.md` and `screencast-script.md` in this
folder, and the images in `../screenshots/`. `claims-lint` scans every file here through its
`listing/**/*` pattern.

## Rules this copy follows

- Field limits and media sizes from Shopify's
  [Best practices for apps in the Shopify App Store](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices),
  read again on 23 October 2026 (ADR-301): app name 30 characters, app introduction 100, app
  details 500, each feature 80, up to 5 search terms; screenshots 1600 × 900 px (16:9), 3 to 6 of
  them, at least one of the app's interface, cropped of browser chrome and sensitive information,
  with alt text, and no pricing, reviews or promised outcomes; feature image 1600 × 900 px with
  alt text, no Shopify logos and not repeating the card subtitle; feature video 2 to 3 minutes
  with screencasts at most 25% of it; app icon 1200 × 1200 px, JPEG or PNG, square with padding,
  no text, screenshots or Shopify trademarks. The pages state no limit for the app card subtitle;
  the submission form's counter decides.
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements):
  no statistics or data in listing content or the subtitle (4.3.3, 4.4.1), no "the first", "the
  best" or "the only" (4.3.3), pricing only in the pricing section (4.2), no reviews or
  testimonials outside their fields (4.3.6), only languages the app's interface supports (4.3.2).
- PLAN §3 claims policy, enforced by `claims-lint` on this folder.
- ADR-141: the copy never says Rampsmith edits, patches or changes a merchant's theme, and never
  offers a theme or code fix. The pull-request channel is off in the App Store build, so no line
  below mentions it; "Add when the code channel is on" at the end keeps the lines for the day
  Shopify confirms requirement 5.1.1 in writing.
- Character counts were computed with `len()` over the text in the quotation blocks.

## Build status

A line may go into the submission only if it is true in the running app. The "Evidence" column is
what proves it today; the `release-verifier` checks the table before submission.

| Copy line | Built in the App Store build | Evidence |
| --- | --- | --- |
| Scans across page types and interactive states | Yes (engine pipeline; the scan starts from the Overview) | `packages/engine` pipeline and corpus tests, `docs/evidence/r1-lane-b.md`; live check in LAUNCH.md E |
| Ranked findings with plain-language explanations | Yes: Issues and Issue detail screens | `apps/web/tests/app-screens.spec.ts` |
| AI-drafted alt text with approve, edit and undo | Yes: Review fixes screen | `app-keyboard.spec.ts`, `app-journey.spec.ts`; live alt text check in LAUNCH.md E |
| Remediation record with CSV and JSON export | Yes: Remediation log screen | `app-screens.spec.ts` (remediation log) |
| Accessibility statement generator | Yes: Accessibility statement screen | `app-screens.spec.ts` (accessibility statement) |
| Weekly rescans | Yes: Settings, "Rescan every week" (paid plans) | `app-screens.spec.ts` (settings) |
| Optional footer link and barrier-report form (theme app embed) | Yes; off until the merchant turns it on; the app links to the theme editor to do so | `packages/theme-app-ext-test`, `app-review.spec.ts` (setup deep link) |
| Corrected headings and link text in descriptions and pages | No (PLAN §5 R2, Growth plan); the app shows it as a locked feature | Not built; not in the copy |
| Daily scans and regression alerts | No (PLAN §5 R2) | Not built; not in the copy |
| Pull requests for the merchant's developer | Built behind a flag that is off in the App Store build (ADR-141) | Not in the copy |
| Patched theme package | Retired (ADR-141, requirement 1.1.3) | Not in the copy |

## App name

Limit 30 characters. Trademark clearance comes first (FOUNDER_SETUP.md step 1). The name must
match the app configuration file (requirement 4.1.1; `shopify.app.toml` says `Rampsmith`).

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

> Rampsmith checks your storefront against automated WCAG 2.2 AA tests, on key pages and in menus, cart drawers and pop-ups. Each finding is ranked by its effect on shoppers and explained in plain language. Review AI-drafted alt text for your product images, then approve, edit or undo it in one click. Keep a dated record of every change and generate an accessibility statement. Automated checks cannot find every barrier, so Rampsmith lists what needs a human review.

Count: 467 / 500.

## Feature list

Limit 80 characters each.

1. > Scans key pages plus menus, cart drawers, variant pickers and pop-ups

   Count: 69 / 80.

2. > Ranks findings by their effect on shoppers, in plain language

   Count: 61 / 80.

3. > Drafts alt text with AI for you to approve, edit or undo in one click

   Count: 69 / 80.

4. > Keeps a dated record of every finding, fix, approval and verification scan

   Count: 74 / 80.

5. > Generates an accessibility statement that lists what automation cannot check

   Count: 76 / 80.

6. > Rescans every week so new barriers show up in your issue list

   Count: 63 / 80.

7. > Fixes use your store's own data, with no overlay or toolbar

   Count: 59 / 80.

8. > Optional footer link to your statement and a barrier-report form you turn on

   Count: 76 / 80.

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

Plan features, as entered in "Top features". Only what the app does today is listed; the plan
table in `crates/billing` already carries the later features, and the app shows them as locked.

- **Free:** monthly scan of the home page and 5 pages; alt-text drafts and data fixes for the
  first 25 images, once.
- **Starter:** weekly scans with 3 sample pages per template; data fixes; 2,000 alt-text drafts
  a month.
- **Growth:** daily scans with 10 sample pages per template (when built); 10,000 alt-text drafts
  a month.
- **Pro:** daily scans of every template variant with 25 samples each (when built); 50,000
  alt-text drafts a month.

Founder decision raised by ADR-141's consequence and the state of the build: with the patched
theme package retired and the pull-request channel off, Starter, Growth and Pro differ mainly in
scan depth and draft volume until description rewrites and regression alerts ship (PLAN §5 R2).
Entering the prices as written is pre-approved (17 October 2026); whether to launch the paid
tiers before those features exist is for the founder (`docs/LAUNCH.md` section C, row 13).

Description of additional charges: none.

## Search terms

Up to 5.

1. accessibility
2. WCAG
3. alt text
4. accessibility statement
5. screen reader

## Integrations

Up to 6. None at launch. (GitHub is listed only when the pull-request channel is on.)

## Languages

English only at launch (PLAN §8: English ships first). Requirement 4.3.2 allows listing only
languages the app's interface supports.

## Geographic requirements and API access

Requirement 4.3.8 asks listings to state specific API permissions. Draft text for that field:

> Rampsmith reads products, files, pages, blogs, menus, themes and store languages, and writes
> only the product, file, page, blog and menu changes you approve. It never writes theme files
> and requests no customer or order data.

Scopes and their reasons are PLAN §14 and `reviewer-instructions.md`. `infra/railway/tests/test_shopify_app_config.py`
fails if `shopify.app.toml` asks for any other scope.

## Links

| Field | Value |
| --- | --- |
| Privacy policy | `https://[DOMAIN]/privacy` (draft in `docs/legal/privacy-policy.md`, needs attorney review and founder approval) |
| Support | `[SUPPORT URL]` and `[SUPPORT EMAIL]` |
| FAQ or documentation | `[DOCS URL]` |
| Demo store | `[DEMO STORE URL]`: a development store page that shows a finding and its fix |

## Media

### Screenshots (6, desktop, 1600 × 900 px)

Taken from the running App Home against the typed fake api by
`pnpm --filter @rampsmith/web run listing:screenshots`
(`apps/web/tests/listing-screenshots.spec.ts`). A test (`src/lib/app/listing.test.ts`) checks the
count, the pixel size of each file and that each has alt text below. They contain no pricing,
reviews, outcome promises or personal data: the store is the fictional "Demo Store", the
approver "Sam Merchant" is a made-up name, and the product pictures are drawn illustrations.
The Polaris components are the repository's test shim, so the files show Rampsmith's own layout
and wording with the shim's styling; retake them on a development store with Shopify's Polaris
before submitting (LAUNCH.md section E, "Listing screenshots on the real admin").

| File | Alt text |
| --- | --- |
| `../screenshots/01-overview.png` | Rampsmith overview showing the latest scan, open issues by impact, fixes waiting for review and the current plan |
| `../screenshots/02-issues.png` | Rampsmith list of open accessibility issues ranked by impact, each with its WCAG criterion and whether a fix is ready |
| `../screenshots/03-issue-detail.png` | One issue explained in plain language with its WCAG 2.2 criterion, the page and element it appears on, and its fix |
| `../screenshots/04-review-fixes.png` | Review queue of AI-drafted alt text for product images with Approve, Edit and Reject, and applied changes with Undo |
| `../screenshots/05-remediation-log.png` | Dated remediation log of every fix with who approved it, how it was verified, and CSV and JSON export buttons |
| `../screenshots/06-accessibility-statement.png` | Accessibility statement editor for the store, with business name, contact details and a draft notice |

The Overview screenshot shows a pass-rate sentence. Requirement 4.3.3 limits statistics in
listing *content* (text); the screenshot is interface, but the founder may prefer to retake that
one without the "Checks" card.

### Feature media, app icon and video

- **Feature image (1600 × 900 px, alt text):** not produced. It needs the founder's brand mark
  and a decision on its content; it must not repeat the subtitle or show Shopify logos.
- **App icon (1200 × 1200 px, no text):** not produced. It needs the founder's brand mark, after
  trademark clearance (FOUNDER_SETUP.md step 1).
- **Video (2 to 3 minutes, optional):** the review screencast (`screencast-script.md`) is a
  different file with a different purpose; a promotional video is the founder's choice.

## Add when the code channel is on

Only if Shopify confirms in writing that a pull request the merchant's developer reviews and
merges meets requirement 5.1.1 (ADR-141, decision 3), and the flag is turned on: add the feature
"Prepares theme code fixes as pull requests for your developer to review" (71 characters), the
sentence "Fixes in theme code are prepared for your developer to review." to the app details
(the total stays under 500), the integration "GitHub", and the reviewer steps in
`reviewer-instructions.md` marked "only with the code channel on". Never add the patched theme
package: requirement 1.1.3 rules it out.

## Add when the R2 features ship

"Corrected headings and link text in descriptions and pages after you approve" (75 characters) and
"Flags new barriers after theme or product changes" once description rewrites and regression
alerts exist in the app.
