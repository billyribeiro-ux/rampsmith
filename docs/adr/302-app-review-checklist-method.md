# ADR-302: How the App Review checklist is checked, and the setup deep link

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (performance and App Review)

## Context

PLAN §14's "App Review checklist (gate for R2)" has nine lines, and LAUNCH.md section A says
everything App Review checks must already pass before the founder submits. The lines are short;
Shopify's own
[App requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
(read 23 October 2026) is longer and numbered. Its item 9.1 asks theme app extensions to work in
the theme editor and to give setup instructions with deep links; the
[theme app extension configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)
page (read 23 October 2026) gives the deep link:
`https://<myshopifyDomain>/admin/themes/current/editor?context=apps&template=<template>&activateAppId={api_key}/{handle}`,
where `api_key` is the app's `client_id` and `handle` "is the filename of the block's Liquid
file", with `template` optional. Requirement 5.1.3 (ADR-161) says the same in the numbered
rules: setup instructions, with a deep link strongly recommended.

The numbered App Store requirements page (`app-store-requirements`) could not be fetched on
23 October 2026 (the documentation fetcher timed out on it), so rule numbers other than those the
checklist page restates are the ones read on 17 and 19 October 2026 (ADR-141, ADR-142).

## Decision

1. `docs/evidence/r2-app-review-checklist.md` lists every item of the PLAN §14 checklist and every
   applicable item of Shopify's checklist, with PASS, FIXED or FOUNDER and evidence that runs.
   A FAIL is fixed in the same pull request or the work is not finished.
2. What a browser can show goes into `apps/web/tests/app-review.spec.ts`; what the app
   configuration can show goes into `infra/railway/tests/test_shopify_app_config.py`. Both run in
   CI already.
3. The app links to the theme editor with the app embed ready to switch on, from Settings,
   "Online store": `embedActivationUrl(shop, SHOPIFY_API_KEY)` in `apps/web/src/lib/app/nav.ts`.
   The handle is `accessibility`, the file name of `extensions/theme-app-ext/blocks/accessibility.liquid`
   (ADR-161); the shop must be a `*.myshopify.com` domain and the key non-empty or no link is
   shown. The link opens with `target="_top"`, as the plan page link does. It uses the shop's
   `myshopify.com` host, as the documentation shows, not `admin.shopify.com/store/...`.
4. The scope list is pinned to PLAN §14's ten scopes by a test, so a change to `shopify.app.toml`
   is a visible decision. The three write scopes with no shipped screen (`write_products`,
   `write_content`, `write_online_store_navigation`) are a requirement 3.2 risk until R2's
   description and page fixes ship; the founder decides whether to submit without them
   (LAUNCH.md C row 13).

## Consequences

- One small screen change (a section in Settings) and its message keys.
- The checklist is a living file: when the pull-request channel's flag is turned on, rows 5.1.1
  and 1.1.3 need a new pass.
- Founder-only rows (demo store, recording, icon, legal pages, Lighthouse on a real store) are
  rows in LAUNCH.md C and E, not blockers for builders.

## Rejected alternatives

- Treating the nine PLAN lines as the whole checklist: Shopify's list has items (setup
  instructions, no pop-ups, incognito, SameSite) that PLAN does not name.
- Deep-linking with `admin.shopify.com/store/<handle>/themes/current/editor`: it probably works
  too, but the documented form is what App Review's reviewers use.
