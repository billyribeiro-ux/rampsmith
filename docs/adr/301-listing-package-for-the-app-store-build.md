# ADR-301: The App Store listing package describes the App Store build

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (performance and App Review)

## Context

LAUNCH.md section B asks for an App Store listing package: copy that passes `claims-lint`,
screenshots captured from the running app, a demo screencast script and reviewer test
instructions. The WS-5 drafts (17 October 2026) listed every PLAN feature as "not built yet",
included the pull-request channel and the patched theme package, and left media out. ADR-141
(decided 19 October 2026) retires the theme package and keeps the pull-request channel off in the
App Store build until Shopify confirms requirement 5.1.1 in writing.

Read on 23 October 2026 from
[Best practices for apps in the Shopify App Store](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices)
and the [App requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
(through the documentation fetcher; `curl` to `shopify.dev` is blocked by the proxy):

- Screenshots: "Screenshots should be 1600px by 900px (16:9)"; "Include 3-6 desktop screenshots,
  including at least one of your app's UI"; "Crop out browser chrome and sensitive information";
  "avoid PII, and don't include pricing, reviews, or outcome guarantees"; "Provide alt text".
  File format is not specified.
- Feature image 1600 x 900 px with alt text, no Shopify logos, not repeating the subtitle; feature
  video 2 to 3 minutes with screencasts at most 25%.
- App icon 1200 x 1200 px, JPEG or PNG, square with padding, no text, screenshots or Shopify
  trademarks.
- Demo development store linked to the most relevant page, with instructions; a complete English
  (or subtitled) screencast of setup and features for review.

## Decision

1. The listing copy states only what the App Store build does today. `listing.md` carries a
   "Build status" table with the evidence for every line; features of PLAN §5 R2 that are not in
   the build (description rewrites, daily scans, regression alerts) and the code channels stay
   out of the copy and sit in "Add when ..." sections for the day they are true.
2. Screenshots are taken from the running App Home against the typed fake api by a Playwright
   spec (`apps/web/tests/listing-screenshots.spec.ts`, run with
   `pnpm --filter @rampsmith/web run listing:screenshots`, its own config so the pull-request
   gate does not retake them). The viewport is 1600 x 900 at device scale 1, so each PNG is
   exactly that size. A vitest file checks the count, the size and the alt text.
3. The screenshots show the repository's Polaris test shim (ADR-094), fictional store and people,
   and drawn product pictures. They are a package ready for review of content and wording; the
   founder retakes them on a development store with Shopify's Polaris before submission (a row in
   LAUNCH.md section E). Nothing in them is a claim about the real admin's look.
4. The feature image, the app icon and any promotional video are not produced: they need the
   founder's brand mark and trademark clearance, and an invented mark would be a brand decision.
5. The reviewer instructions and the screencast script describe the build a reviewer can reach:
   no Code screen, no GitHub connection, no theme download. The screencast script lists seven
   scenes of about four and a half minutes.

## Consequences

- Starter, Growth and Pro differ mostly in scan depth and draft volume until R2's description
  rewrites and alerts ship, because the theme package is retired and the pull-request channel is
  off. The founder decides whether to launch the paid tiers first (LAUNCH.md C row 13); PLAN §20's
  prices stay pre-approved.
- The reviewer instructions ask the founder to drop the three write scopes that no shipped screen
  uses if the R2 fixes do not ship before submission (requirement 3.2).
- Retaking the screenshots is one command; their alt text lives in `listing.md`, and the test
  fails when a file and its row disagree.

## Rejected alternatives

- Keeping the WS-5 copy and marking it "not built": reviewers read the copy, so every line must be
  true in the build they open.
- Generating an icon or feature image: a brand decision, and an unclear trademark position.
- Running the screenshot spec in the normal e2e job: it rewrites tracked files on every run.
