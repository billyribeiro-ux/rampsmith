# ADR-141: Shopify App Store requirement 5.1.1 and the two code-fix channels

- Status: Proposed (WS-5; the architect accepts it when the streams are integrated)
- Date: 2026-10-17
- Evidence: [`docs/evidence/ws-5-launch-docs.md`](../evidence/ws-5-launch-docs.md), section "Vendor facts"

## Context

PLAN §4 cites "App requirements 5.1" for the rule that apps "should avoid requiring manual code
changes and must let merchants preview edits before publishing", linking
`https://shopify.dev/docs/apps/launch/app-requirements-checklist`. Read on 17 October 2026:

- That URL now redirects to
  [Best practices for apps in the Shopify App Store](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices).
  Its section 9 says: "Use theme app extensions to modify merchant themes, and avoid requiring
  manual code changes" and "Let merchants preview edits before publishing storefront changes."
  These are best practices; the page says the numbered requirements live elsewhere.
- The numbered requirements are on
  [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).
  Requirement 5.1.1, "Use theme app extensions", says: "If your app modifies the merchant's
  theme, you need to use theme app extensions." and "You or merchants should not make any code
  changes to the theme."
- [Pass app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review) lists
  as a common rejection (resubmission needed): "Theme changes that don't use theme app extensions".

Rampsmith never writes theme files (ADR-004). Two of its three fix channels still end in a theme
code change that the merchant or their developer makes: the GitHub pull request, which the
merchant's developer merges, and the patched theme package, which the merchant installs and
publishes. Requirement 5.1.1's second sentence can be read to cover both.

## Decision

This ADR records the requirement and how the launch documents handle it. It changes no scope.

1. The App Store listing and the reviewer instructions (`listing/shopify-app-store/`) present the
   app's value without the code channels: scanning, ranked findings, store data fixes with
   approval and undo, the remediation record and the accessibility statement. Pull requests and
   theme packages are described as optional handoffs to the merchant's own developer, prepared
   for review and never applied by Rampsmith.
2. The reviewer instructions state that Rampsmith does not modify the theme, name requirement
   5.1.1, and point to the theme app extension (statement link and barrier-report form) as the
   only storefront change the app makes.
3. Whether the code channels may appear in the App Store build at all is a founder and architect
   decision, recorded under "Waiting on founder". Before R2 depends on it, the founder can ask
   Shopify (Partner support or a pre-submission question) how 5.1.1 applies to a pull request
   the merchant's developer reviews and merges, and to a theme package the merchant installs.

## Plan correction

- PLAN §4, row "Apps should avoid requiring manual code changes": cite requirement 5.1.1 with
  both sentences quoted above and link `shopify-app-store/app-store-requirements`; keep the
  best-practices link for the preview rule.
- PLAN §25 risk register, row "App Review objects to the patched-package flow as a manual code
  change": extend it to the GitHub pull-request channel and raise the likelihood from Medium to
  High; trigger to act: any review note citing requirement 5.1.1.
- PLAN §29 sources: replace the app-requirements-checklist link with the two pages above.

## Consequences

- R2's exit criterion "Shopify App Review passed" may require shipping the App Store build with
  the code channels hidden or reframed; the data-fix channel and every PLAN §5 R1 criterion are
  unaffected.
- Listing copy never says the app "edits", "patches" or "changes" the theme.

## Rejected alternatives

- Ignoring the requirement because PLAN §4 cited the softer wording: the numbered requirement is
  what App Review applies.
- Removing the code channels now: a scope change that needs the founder.
