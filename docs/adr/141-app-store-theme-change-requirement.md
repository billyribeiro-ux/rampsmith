# ADR-141: Shopify App Store requirements 5.1.1 and 1.1.3 and the two code-fix channels

- Status: Proposed (WS-5; the architect accepts it when the streams are integrated)
- Date: 2026-10-17; amended 2026-10-19 (requirement 1.1.3 added, per the architect ruling of 17 October)
- Evidence: [`docs/evidence/ws-5-launch-docs.md`](../evidence/ws-5-launch-docs.md), section "Vendor facts"

## Context

PLAN §4 cites "App requirements 5.1" for the rule that apps "should avoid requiring manual code
changes and must let merchants preview edits before publishing", linking
`https://shopify.dev/docs/apps/launch/app-requirements-checklist`. Read on 17 October 2026 and
again on 19 October 2026:

- That URL now redirects to
  [Best practices for apps in the Shopify App Store](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices).
  Its section 9 says: "Use theme app extensions to modify merchant themes, and avoid requiring
  manual code changes" and "Let merchants preview edits before publishing storefront changes."
  These are best practices; the page says the numbered requirements live elsewhere.
- The numbered requirements are on
  [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).
  Two of them bear on Rampsmith's fix channels:
  - **5.1.1, "Use theme app extensions."** "If your app modifies the merchant's theme, you need
    to use theme app extensions." and "You or merchants should not make any code changes to the
    theme."
  - **1.1.3, "Direct merchants to the Shopify Theme Store."** "Your app must not allow merchants
    to download themes." and "Themes can only be installed via the Shopify Theme Store."
    (Re-read on 19 October 2026 at that URL, section 1.1, "Build and operate within Shopify's
    platform".)
- [Pass app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review) lists
  as a common rejection (resubmission needed): "Theme changes that don't use theme app extensions".

Rampsmith never writes theme files (ADR-004). Two of its three fix channels still end in a theme
code change that the merchant or their developer makes, and one of them hands the merchant a
theme:

| Channel | 5.1.1 ("should not make any code changes to the theme") | 1.1.3 ("must not allow merchants to download themes"; "can only be installed via the Shopify Theme Store") |
| --- | --- | --- |
| GitHub pull request, which the merchant's developer reviews and merges | Can be read to apply: the developer makes a code change to the theme | Does not apply on its face: no theme is downloaded; the developer receives a diff in a repository the merchant owns |
| Patched theme package, which the merchant downloads and installs as an unpublished theme | Can be read to apply: installing and publishing it changes the live theme | Applies directly: the merchant downloads a theme, and the install path is an upload, not the Theme Store |
| Store data fixes (alt text, descriptions, pages, menus) through the Admin API | Does not apply: no theme code changes | Does not apply |

The theme package therefore carries two requirements against it, and the second is not a matter
of interpretation as the first can be: its description is the behaviour 1.1.3 names. The pull
request channel carries only the 5.1.1 risk.

## Decision

This ADR records the requirements and how the launch documents handle them. It changes no scope.

1. The App Store listing and the reviewer instructions (`listing/shopify-app-store/`) present the
   app's value without the code channels: scanning, ranked findings, store data fixes with
   approval and undo, the remediation record and the accessibility statement. Pull requests and
   theme packages are described as optional handoffs to the merchant's own developer, prepared
   for review and never applied by Rampsmith.
2. The reviewer instructions state that Rampsmith does not modify the theme, name requirements
   5.1.1 and 1.1.3, and point to the theme app extension (statement link and barrier-report form)
   as the only storefront change the app makes. The step that downloads a theme copy is marked
   as the one that cannot stay in a build the reviewer can reach if 1.1.3 applies.
3. Whether the code channels may appear in the App Store build at all is a founder and architect
   decision, recorded under "Waiting on founder" in `docs/STATUS.md`. The architect's
   recommendation there is to retire the theme-package channel, which 1.1.3 names, and to keep the
   pull-request channel behind its flag. Until the founder answers, both channels are built behind
   a flag that is off in the App Store build, and this ADR's listing and reviewer approach
   stands. Before R2 depends on the answer, the founder can ask Shopify (Partner support or a
   pre-submission question) how 5.1.1 applies to a pull request the merchant's developer reviews
   and merges, and whether any download of a patched theme is acceptable under 1.1.3.

## Plan correction

- PLAN §4, row "Apps should avoid requiring manual code changes": cite requirement 5.1.1 with
  both sentences quoted above and requirement 1.1.3 with both of its sentences, link
  `shopify-app-store/app-store-requirements`, and keep the best-practices link for the preview
  rule.
- PLAN §25 risk register, row "App Review objects to the patched-package flow as a manual code
  change": cite 1.1.3 as well as 5.1.1, extend the row to the GitHub pull-request channel (5.1.1
  only) and raise the likelihood from Medium to High; trigger to act: any review note citing
  requirement 5.1.1 or 1.1.3.
- PLAN §12 and §20, wherever the patched theme package is a plan feature (the Starter plan's
  "patched theme package"): add "subject to ADR-141" until the founder decides.
- PLAN §29 sources: replace the app-requirements-checklist link with the two pages above.

## Consequences

- R2's exit criterion "Shopify App Review passed" may require shipping the App Store build with
  the code channels hidden or reframed; the data-fix channel and every PLAN §5 R1 criterion are
  unaffected.
- If the theme-package channel is retired, the Starter plan loses its "patched theme package"
  line and needs a replacement feature, a pricing decision for the founder (PLAN §20 is approved
  as written until then).
- Listing copy never says the app "edits", "patches", "changes" or "gives" the theme, and never
  offers a theme for download.

## Rejected alternatives

- Ignoring the requirements because PLAN §4 cited the softer wording: the numbered requirements
  are what App Review applies.
- Treating 1.1.3 as satisfied because the downloaded theme is the merchant's own: the text has no
  exception for it ("Your app must not allow merchants to download themes").
- Removing the code channels now: a scope change that needs the founder.
