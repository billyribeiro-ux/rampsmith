# Review screencast script (draft)

Draft for the founder. Nothing here is recorded or submitted. This is the screencast for Shopify
App Review, which must "demonstrate your app's onboarding and features as described in its
listing" and be "in English or have English subtitles" (requirement 4.5.3,
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)).
It is not the listing's promotional video. Updated 23 October 2026 for the App Store build, in
which the code-fix channel is off (ADR-141): there is no Code screen and no theme download to
show, and the script never mentions one.

Record it on a development store with the real Shopify admin and Polaris, after every scene works
there (LAUNCH.md section E). The same scenes pass against the typed fake api in
`apps/web/tests/app-screens.spec.ts`, `app-keyboard.spec.ts`, `app-journey.spec.ts` and
`app-review.spec.ts`, which is why the on-screen names below are the app's own.

## Recording setup

- A development store with a sample catalog, its storefront password set, and a theme with known
  barriers (for example, product images without alt text and an icon-only cart link).
- Screen at 1600 × 900 or larger; browser chrome cropped; no personal data, real customer names
  or credentials on screen.
- Captions in English for every narration line, burned in or as a subtitle file.
- Target length: about 4 minutes 30 seconds.

## Scenes

| # | Time | On screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:30 | Shopify admin, Apps, install Rampsmith from its listing; the app opens inside the admin | "Rampsmith installs like any Shopify app and opens inside your admin. There is no separate login." |
| 2 | 0:30 to 1:15 | Overview, Start a scan, progress, then the latest scan, issues by impact, the checks card and the next scan | "Rampsmith checks your storefront against automated WCAG 2.2 AA tests on your key pages, and opens your menu, cart drawer, a variant picker and the first pop-up to check them too." |
| 3 | 1:15 to 2:00 | Issues, filter by impact, open the top issue: criterion, plain-language explanation, pages and elements it appears on | "Each issue is ranked by its effect on shoppers and explained in plain language. Automated checks find only part of all barriers, so Rampsmith says what needs a person to review." |
| 4 | 2:00 to 3:00 | Review fixes, an AI-drafted alt text for a product image, Edit one word, Save, Approve; the product page shows the new alt text in the browser inspector; back in Rampsmith the change moves to Applied changes and shows Verified; Undo; the old value returns | "Alt text is drafted for you. You review it, edit it if you want, and approve it. Rampsmith writes it to the product image, checks the page again, and keeps one-click undo." |
| 5 | 3:00 to 3:40 | Remediation log, Download CSV; Accessibility statement, fill in the business name and email, the preview updates, Save | "Every fix, approval and verification is kept in a dated record you can export. Rampsmith drafts an accessibility statement for you to edit and publish." |
| 6 | 3:40 to 4:10 | Settings, Online store, Open the theme editor, App embeds, switch on Accessibility statement, Save; the storefront footer shows the Accessibility link; switch it off again | "An optional footer link points shoppers to your statement. It is a theme app embed: you turn it on here, you turn it off here, and nothing stays behind when you remove the app." |
| 7 | 4:10 to 4:40 | Compare plans, Shopify's hosted plan page, switch plans, return to the app; Settings, weekly rescan, notification email, AI budget | "Plans are billed by Shopify. You can upgrade or downgrade there at any time. Settings control how often Rampsmith scans, where emails go, and your monthly AI budget." |

## Wording checks before recording

- Narration and captions follow the PLAN §3 claims policy: they describe what was checked and
  what was fixed, never a legal outcome. `claims-lint` scans this file.
- No statistics in the narration (requirement 4.3.3 applies to listing content; the same care
  keeps the screencast consistent with the listing).
- Never say the app edits, patches or changes the theme (ADR-141). Scene 6 says the merchant
  switches an embed on and off.
