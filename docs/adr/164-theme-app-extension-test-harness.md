# ADR-164: How the theme app extension is tested: liquidjs stand-in, Chromium in the node job

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-7 (`packages/theme-app-ext-test/`)

## Context

The extension is Liquid that only Shopify renders, plus a browser script. The goal asks for
Theme Check, a JavaScript size budget, axe in Chromium on a fixture page with the embed on,
keyboard, focus and error-state tests, and a layout-shift measurement, all inside the pnpm
workspace. `ci.yml` is not this stream's to change: its `node` job runs `pnpm -r test` without
installing a browser, and only the `e2e` job installs Playwright's Chromium, for `apps/web`.
docs/ENVIRONMENT.md: Playwright's browser download is blocked here; `@sparticuz/chromium`
153.0.0 with `playwright-core` 1.64.1 is verified to run axe-core 4.14.0.

Versions and licences read from registry.npmjs.org on 17 and 18 October 2026; none has an
install script, so pnpm's `allowBuilds` list needs no entry:

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| `@shopify/theme-check-node` | 3.30.1 (latest; PLAN §7 pin) | MIT | Theme Check |
| `liquidjs` | 10.30.0 (latest; engines `node >=16`) | MIT | Renders the embed for the fixtures |
| `playwright-core` | 1.64.1 (latest; PLAN §7 pin) | Apache-2.0 | Drives Chromium |
| `@sparticuz/chromium` | 153.0.0 (latest; engines `^22.17.0 \|\| >=24.0.0`) | MIT | A Chromium the node job can run without a download |
| `axe-core` | 4.14.0 (latest; PLAN §7 pin) | MPL-2.0, used unmodified | Accessibility rules |
| `vitest` | 5.0.5 (PLAN §7 pin) | MIT | Runner |

## Decision

1. **A liquidjs stand-in for Shopify's renderer** (`src/render.ts`), covering exactly what the
   embed uses: `block.settings` with the schema defaults, `app.metafields`, `request`, `routes`
   and `shop` as globals visible inside `{% render %}` (other variables must be passed, as on
   Shopify), `t` with Shopify's escaping, `escape` as Ruby's `CGI.escapeHTML`, `asset_url`, and a
   `{% schema %}` tag that renders nothing. Theme Check validates the Liquid against Shopify's
   own object and filter docs, so the stand-in cannot hide a call Shopify would refuse; the
   live check renders it on a development store.
2. **Theme Check offline and pinned.** The suite points `SHOPIFY_TLD_ROOT` at a missing
   directory and `XDG_CACHE_HOME` at an empty one, so Theme Check falls back to the Liquid docs
   bundled in the pinned package (theme-liquid-docs revision `40f966fc`) instead of downloading
   that repository's `main` branch on every run. A test asserts the fallback was used, and
   negative controls prove the run checks these files in the app context.
3. **Chromium in the node job.** `@sparticuz/chromium` is unpacked once in Vitest's global
   setup (parallel files cannot race on it) and launched with `--no-sandbox` only: the pages are
   local fixtures, and none of the package's Lambda switches (`--single-process`,
   `--disable-web-security` and the like) is used. `CHROMIUM_EXECUTABLE_PATH` and
   `CHROMIUM_ARGS` select another build. Two test files run at a time.
4. **Hermetic fixture.** Every request is served by Playwright interception: the storefront
   page, the extension's assets from a stand-in CDN origin, and a fake of the whole app proxy
   path, where "Shopify" signs the query and "the api" verifies it and applies ADR-162's rules
   through the reference modules. Anything else is aborted and recorded, and tests assert
   nothing was.
5. **What is measured and how.** axe-core with WCAG 2.2 A and AA tags plus best practices, in
   four colour and theme combinations and every form state, with negative controls; keyboard
   order and focus rings through real key presses; names, descriptions and invalid state from
   Chromium's accessibility tree (CDP `Accessibility.getPartialAXTree`); layout shift from
   `layout-shift` performance entries without recent input, as Core Web Vitals counts CLS,
   across load, every state and answers arriving 1.2 s after the last input, at 1280 and
   320 px, with a positive control; reflow and WCAG text spacing at 320 px; target sizes;
   cookies, storage and DOM mutations outside the embed.
6. **Knip.** The script is located with `import.meta.resolve`, which knip counts as a use, so
   the asset is not reported as an unused file and no shared knip config changes.

## Consequences

- The node job downloads about 70 MB more from the pnpm store cache and spends about 30 s on
  the browser tests.
- The stand-in can drift from Shopify's renderer in behaviour Theme Check does not see; the live
  checks in LAUNCH.md section E close that gap.
- When `ci.yml` gains a job that installs Playwright's own Chromium for packages, setting
  `CHROMIUM_EXECUTABLE_PATH` there moves these tests onto it with no code change.

## Plan correction

PLAN §23 "By component", add a row: "Theme app extension | Theme Check (theme-app-extension
config, bundled docs), deploy-rule and size-limit checks, a 5 KB script budget, claims-lint,
axe-core, keyboard, focus, error-state and no-JS tests and a layout-shift measurement in
Chromium on a liquidjs-rendered fixture, plus live checks on a development store (ADR-164)".
