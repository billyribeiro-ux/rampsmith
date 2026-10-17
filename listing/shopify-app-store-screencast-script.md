# Review screencast script (draft)

Draft for the founder. Nothing here is recorded or submitted. This is the screencast for Shopify
App Review, which must "demonstrate your app's onboarding and features as described in its
listing" and be "in English or have English subtitles" (requirement 4.5.3,
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)).
It is not the listing's promotional video.

Every scene shows a part of Rampsmith that is **not built yet** at the date of this draft
(17 October 2026); each scene names the PLAN §5 release that builds it. Record only after every
scene works on a development store, and re-record if the ADR-141 decision changes scenes 7 and 8.

## Recording setup

- A development store with a sample catalog, its storefront password set, and a theme with known
  barriers (for example, product images without alt text and an icon-only cart link).
- A second development store whose theme is connected to a test GitHub repository, for scene 7.
- Screen at 1600 × 900 or larger; browser chrome cropped; no personal data, real customer names
  or credentials on screen.
- Captions in English for every narration line, burned in or as a subtitle file.
- Target length: about 6 minutes.

## Scenes

| # | Time | On screen | Narration | Build status |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:30 | Shopify admin → Apps → install Rampsmith from its listing; the app opens inside the admin | "Rampsmith installs like any Shopify app and opens inside your admin. There is no separate login." | Not built yet (R0 step 7, R1) |
| 2 | 0:30–1:15 | Home screen → Run scan → progress, then results: automated checks passed, open findings by impact, next scheduled scan | "Rampsmith checks your storefront against automated WCAG 2.2 AA tests on your key pages, and opens your menu, cart drawer, a variant picker and the first pop-up to check them too." | Not built yet (R1) |
| 3 | 1:15–2:00 | Findings → open the top finding: criterion, plain-language explanation, evidence crop, affected templates; then the panel listing criteria that need a human review | "Each finding is ranked by its effect on shoppers and explained in plain language. Automated checks find only part of all barriers, so Rampsmith lists what needs a person to review." | Not built yet (R1) |
| 4 | 2:00–3:00 | Fixes → an AI-drafted alt text for a product image → edit a word → Approve → the product page shows the new alt text in the inspector → back in Rampsmith the finding shows as verified → Undo → the old value returns | "Alt text is drafted for you. You review it, edit it if you want, and approve it. Rampsmith writes it to the product image, checks the page again, and keeps one-click undo." | Not built yet (R1) |
| 5 | 3:00–3:30 | Fixes → a product description with skipped heading levels → proposed correction as a diff → Approve | "On the Growth plan, Rampsmith also proposes corrections to headings and link text in your descriptions and pages. Nothing changes until you approve it." | Not built yet (R2) |
| 6 | 3:30–4:15 | Record → export; Statement → edit the generated text → save; theme editor → App embeds → turn on Rampsmith → storefront footer shows the "Accessibility" link | "Every finding, fix, approval and verification is kept in a dated record you can export. Rampsmith drafts an accessibility statement for you to edit and publish, and an optional footer link points shoppers to it." | Not built yet (R1) |
| 7 | 4:15–5:00 | Code → connect GitHub → choose the test repository and branch → approve a theme code fix → the pull request on GitHub, one commit per fix, the "Rampsmith verification" check | "For barriers in theme code, Rampsmith prepares a pull request for your developer to review and merge. Rampsmith never edits or publishes your theme." | Not built yet (R2); depends on ADR-141 |
| 8 | 5:00–5:30 | Code → download the theme copy → (developer uploads it as an unpublished theme) → Rampsmith shows the preview scan result | "Or your developer can install a fixed copy of the theme as an unpublished theme. Rampsmith checks its preview first, and your original theme stays in your library." | Not built yet (R2); depends on ADR-141 |
| 9 | 5:30–5:50 | Plan → Shopify's hosted plan page → switch plans | "Plans are billed by Shopify. You can upgrade or downgrade here at any time." | Not built yet (R2) |
| 10 | 5:50–6:10 | Settings → scan schedule, notification email, AI budget, storefront password field | "Settings control how often Rampsmith scans, where alerts go, and your monthly AI budget." | Not built yet (R1) |

## Wording checks before recording

- Narration and captions follow the PLAN §3 claims policy: they describe what was checked and
  what was fixed, never a legal outcome. `claims-lint` scans this file.
- No statistics in the narration (requirement 4.3.3 applies to listing content; the same care
  keeps the screencast consistent with the listing).
