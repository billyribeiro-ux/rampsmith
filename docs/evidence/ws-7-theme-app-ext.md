# WS-7 evidence: Shopify theme app extension

- Stream: WS-7 (PLAN §14 "Theme app extension"), branch `ws/theme-app-ext`, draft pull request
  [#4](https://github.com/billyribeiro-ux/rampsmith/pull/4) into `r0-foundations` (stream CI
  only; never merged).
- Started from `r0-foundations` at `16926b5`; `r0-foundations` at `4fdfb3b` was merged in
  (`9c3c3d8`) so the pull request could run `ci.yml`.
- Owned paths only: `extensions/theme-app-ext/`, `packages/theme-app-ext-test/`, ADRs 161 to
  164 and this file. `pnpm-lock.yaml` changed only through `pnpm install`.
- Dates: 17 and 18 October 2026 (UTC).

## What was built

`extensions/theme-app-ext/` (deployable files, 6):

| File | What it is |
| --- | --- |
| `shopify.extension.toml` | `name` and `handle` `rampsmith-accessibility`, `type = "theme"` |
| `blocks/accessibility.liquid` | The one app embed (`target: "body"`, deactivated until the merchant enables it; Shopify's default). A labelled `<aside>` with the "Accessibility" link to the published statement and, when the merchant turns it on (default off), the barrier-report form. Theme-editor notice when nothing is configured. Statement URL from the embed setting or the app-data metafield `rampsmith.statement_url`, only if `https://` or same-site and free of tabs and line breaks; proxy path from `rampsmith.proxy_path` only in the shape `/<a\|apps\|community\|tools>/<subpath>` |
| `snippets/rampsmith-barrier-report.liquid` | The form inside `<details>`: description (required, 2000 characters), optional email, hidden page path (public page types only, never app proxy paths), page type and locale, a honeypot, the privacy notice and policy link, the submit button and a `role="status"` line. Posts to `/apps/rampsmith/barrier-report` without JavaScript |
| `snippets/rampsmith-a11y-styles.liquid` | Under 2 KB of inline CSS scoped to `.rs-a11y`: three colour schemes, 44 px targets, `currentColor` borders and 3 px focus rings, reserved space for the error and status lines, no animation |
| `assets/rampsmith-barrier-report.js` | 4,743 bytes (1,795 gzip, 1,539 brotli), loaded with `defer` only when the form is shown: in-page sending with `fetch`, inline errors with `aria-invalid` and `aria-describedby`, focus on the first problem, `aria-disabled` while sending, one request per press, field errors from a 422, every string from `data-msg-*`; no cookies, storage or DOM changes outside its form |
| `locales/en.default.json`, `locales/en.default.schema.json` | Every storefront and theme-editor string |

Root-level tooling files, never deployed (Shopify CLI uploads only `*/*`): `.theme-check.yml`
(`extends: theme-check:theme-app-extension`) and `tsconfig.json` (type-checks the script with
`checkJs`, so ESLint's typed rules apply).

`packages/theme-app-ext-test/` (`@rampsmith/theme-app-ext-test`, in the pnpm workspace):

- `src/render.ts`: liquidjs stand-in for Shopify's renderer (ADR-164); `src/fixture.ts`: the
  storefront fixture; `src/browser.ts`: Chromium harness with request interception and a fake
  of the whole signed app proxy path; `src/chromium.ts`; `src/locales.ts`; `src/contrast.ts`;
  `src/extension-files.ts` (Shopify CLI 4.9.4's deploy rules and the documented limits).
- Reference modules for the api (tests first): `src/app-proxy-signature.ts` (Shopify's
  signature, reproducing both documented vectors; reserved-parameter, freshness and 64-pair
  rules) and `src/barrier-report.ts` (body rules, `exportCell`, `mentionsShopper`).

## Tests

`pnpm --filter @rampsmith/theme-app-ext-test test` (Vitest 5.0.5) at `9dda025`, Node 26.12.0,
pnpm 12.14.0, Chromium 153.0.8010.0 (`@sparticuz/chromium` 153.0.0), with
`GITHUB_ACTIONS=true` as in CI:

```text
 Test Files  11 passed | 1 skipped (12)
      Tests  126 passed | 3 skipped (129)
   Duration  31.05s
```

The three skipped tests are the live checks below; each prints
`LIVE CHECK SKIPPED: … needs LAUNCH.md section C rows …` when its inputs are absent.

| File | Tests | What it proves |
| --- | --- | --- |
| `app-proxy-signature.test.ts` | 18 | Shopify's two documented signatures (secret `hush`): `4c68c862…7395ddb`, `e072b6d7…ff8093cb`; byte-order sort of whole `key=value` strings; tampering, wrong secret, missing, repeated, short, long and uppercase signatures; the 300 s / 30 s window; shop, timestamp, path prefix and customer id each refused when repeated with the client's value first; malformed path prefixes; the 64-pair cap |
| `barrier-report.test.ts` | 22 | The body rules: trimming, required description, the 2000 UTF-16-unit limit, WHATWG email, control, bidi and invisible characters, NFC after removal, joiners kept, page path rules and the public page-type allowlist, honeypot and 3 s floor, the 32 KiB limit, a maximal non-Latin report fits; `exportCell` formula defusing; `mentionsShopper` whole-address and digit-only phone matching |
| `extension-structure.test.ts` | 13 | TOML keys; only the four deployable directories; every file one level deep with a CLI-allowed extension; 10 MB, 100 KB Liquid, 30 blocks, 100 locale files of 15 KB; strict JSON; one `body` embed, name under 25 characters, no schema `javascript`/`stylesheet`; translated settings; no `content_for_*`, `include` or inline SVG; no absolute URLs; a script with no storage, HTML injection, eval or other network calls; no animation |
| `render.test.ts` | 19 | Link sources and precedence, hostile statement URLs (`javascript:`, `//`, `/\`, tabs, line breaks, `http://`), editor notice only in design mode, form off by default, default and moved proxy paths and hostile ones, hidden fields, no paths from account, gift card, password or app proxy pages, escaping, privacy link, every `data-msg-*`, colour schemes |
| `locales.test.ts` | 6 | Every storefront and editor key used exists and every defined key is used; no HTML in strings; a pseudo-locale render shows no text or label that bypasses the locale files |
| `claims.test.ts` | 3 | The root config covers extension locales and Liquid; `claims-lint` reports `5 files scanned, no banned claims`; a planted "Fully compliant" fails it |
| `theme-check.test.ts` | 3 | Zero Theme Check offenses at any severity (theme-app-extension config, app context); the bundled Liquid docs were used, never a download; a broken copy trips `TranslationKeyExists`, `ParserBlockingScript`, `AppBlockValidTags`, `AppBlockMissingSchema` and `MissingAsset` |
| `budgets.test.ts` | 7 | Script under 5,120 bytes uncompressed and under 2 KB gzip and brotli; no script unless the form is shown; one `defer` script; inline CSS under 2 KB; embed HTML under 3 KB (link) and 8 KB (with form); fixed schemes at 4.5:1 or better for text and errors |
| `browser-axe.test.ts` | 8 | axe-core 4.14.0 (WCAG 2.2 A/AA plus best practices): zero violations in four scheme and theme combinations across closed, open, error and status states; link only, editor notice, form without its script; the embed alone; the theme fixture alone; a seeded fault is reported |
| `browser-form.test.ts` | 17 | Keyboard order and Enter on the disclosure; 2 px+ focus rings; names, descriptions, required and invalid state from Chromium's accessibility tree; focus moves to the first problem; errors clear on fixing; blank descriptions refused; the api's field errors; sending, announcing and clearing; one request per press; rate limiting, server error, non-JSON error, dropped connection; the too-fast drop; without JavaScript, native validation and a full-page post |
| `browser-layout.test.ts` | 10 | Layout shift exactly 0 from load through every state, with answers 1.2 s after the last input, at 1280 and 320 px and on a short page, with a positive control; no horizontal scroll at 320 px with WCAG text spacing; target sizes; no cookie, storage or outside DOM change; no script requested when the form is off; the script runs deferred; script messages come from the locale files |
| `live.test.ts` | 3 skipped | See section E below |

## Local gates (all at `9dda025`)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Lockfile up to date |
| `pnpm run lint` (ESLint 10.13.0, `--max-warnings=0`, repo-wide) | No problems |
| `pnpm run format:check` (Prettier 3.9.10) | All files formatted |
| `pnpm run typecheck` (tsc 6.0.3, svelte-check), including `tsc -p extensions/theme-app-ext/tsconfig.json` | 0 errors, 0 warnings |
| `pnpm run knip` (knip 6.41.0) | No issues |
| `node packages/claims-lint/src/main.ts` | `claims-lint: 19 files scanned, no banned claims` |
| `pnpm audit` (via the security audit) | No advisories in 503 packages |

## CI on the pinned toolchains (pull request #4)

| Run | Head | Result |
| --- | --- | --- |
| [39087363850](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39087363850) | `9c3c3d8` | node job failed: the claims test's negative control read plain output, but the CLI prints annotations when `GITHUB_ACTIONS=true`. Every other job green; the browser tests passed on the runner's `@sparticuz/chromium`. Fixed in `63a0792` (reproduced locally with `GITHUB_ACTIONS=true` first) |
| [39089272140](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39089272140) | `efff3a4` | All jobs green: rust, node, e2e, contracts, images (api, web, engine, egress) |
| Latest | see the pull request's checks | Recorded in docs/STATUS.md's WS-7 row |

## Decisions

- [ADR-161](../adr/161-theme-app-extension.md): extension format and design, as checked on
  shopify.dev and in Shopify CLI 4.9.4's deploy rules.
- [ADR-162](../adr/162-app-proxy-barrier-report-contract.md): the app proxy contract the api
  must serve: configuration, parsing, signature, reserved parameters, limits, replay, spam,
  answers, personal data, retention, compliance webhooks, export, storage.
- [ADR-163](../adr/163-embed-app-data-metafields.md): the app-data metafields the embed reads
  and the activation deep link.
- [ADR-164](../adr/164-theme-app-extension-test-harness.md): the liquidjs stand-in, the
  offline Theme Check and Chromium in the node job; dependency versions and licences checked on
  the registry.

## Security audit

The `security-auditor` subagent type was not available in this session, so a general-purpose
agent ran its brief verbatim (`.claude/agents/security-auditor.md` on `main`) at effort `max`,
read-only, on ADR-161 to 163, the extension, both reference modules and the fake proxy.

| Round | Head | Result |
| --- | --- | --- |
| 1 | `8e2ac35` | PASS: 0 critical, 0 high, 5 medium (reserved parameters, duplicate hash, lookup-key rotation, CSV formulas, public api host), 10 low |
| 2 | `7fed777` | PASS: 14 of 15 resolved; 1 low open (tabs and line breaks in the embed's URL checks); 4 new lows (replay cache cap, shop-wide cap order, literal compliance matching, wording) |
| 3 | `9c8d545` | PASS: all resolved; 2 new lows (a `/` proxy path; email matching inside longer addresses) |
| 4 | `9dda025` | PASS: both resolved, nothing new |

Every finding was fixed in code or in the contract; none was waived.

## Integration notes (shared files this stream may not edit)

1. `shopify.app.toml`: add `write_app_proxy` to `[access_scopes].scopes` and the `[app_proxy]`
   block (`url = "https://<webhook host>/shopify/app-proxy"`, `prefix = "apps"`,
   `subpath = "rampsmith"`), per environment (ADR-162).
2. `docs/adr/README.md`: index ADR-161 to 164.
3. PLAN corrections, written out in each ADR's "Plan correction": §7 (Theme Check also lints
   the extension), §14 (Theme app extension paragraph, Access scopes row, App proxy subsection,
   App Home `/reports` row, App Review checklist items), §18 (threat row; fuzzing list), §19
   (data inventory row; Railway subprocessor row), §22 (public hosts), §23 (by-component row).
4. LAUNCH.md section E: the rows below.
5. The main builder (api, migrations, App Home): implement ADR-162 in `crates/api` with
   Shopify's vectors and the reference modules' cases as Rust tests; the `barrier_reports`
   migration under `TenantTx` and RLS with the isolation suite; HKDF purpose keys per master
   key id in `crates/crypto` and the rotation re-hash; the edge allowlist on the webhook host;
   `metafieldsSet` for `rampsmith.statement_url` when a statement is published, and the
   merchant-confirmed `rampsmith.proxy_path`; App Home `/reports` (read, delete, CSV export
   with `exportCell`'s rules) and the onboarding deep link
   `https://<shop>/admin/themes/current/editor?context=apps&activateAppId=<client id>/accessibility`.
6. WS-10: a daily barrier-report digest template (fixed subject, a count and a link). WS-13 or
   the main builder: where the statement is published, then write `statement_url`. WS-5: the
   privacy policy and DPA list barrier reports (optional email, 12 months).
7. `ci.yml` needs no change: the node job runs this package's tests, including Chromium. The
   package adds about 70 MB to the pnpm store cache and about 30 s to the node job.
8. Environment: no blocked download was needed. Chromium came from `@sparticuz/chromium`, as
   docs/ENVIRONMENT.md describes; Theme Check runs on its bundled docs offline.

## LAUNCH.md section E: live checks

Each runs from the repository root once its inputs are set as GitHub Actions secrets (never
typed into a chat); none prints a secret or the storefront password.

| Live check | Inputs (C) | Substitute test now | Live command |
| --- | --- | --- | --- |
| The embed on development store A: renders, axe finds nothing in it, the served script is under 5 KB and deferred. First run `shopify app deploy`, then enable the embed and its form through the deep link the test prints | 1, 3 | `browser-axe`, `budgets`, `render` and `theme-check` suites on the liquidjs fixture | `pnpm --filter @rampsmith/theme-app-ext-test exec vitest run test/live.test.ts` with `SHOPIFY_API_KEY`, `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_STORE_PASSWORD` |
| A barrier report through the real signed app proxy to the staging api (`200 {"status":"received"}`) | 1, 3, 8 | `browser-form` against the fake signed proxy and the reference modules | The same command with `RAILWAY_TOKEN` also set, after the api endpoint is deployed to staging |
| No trace on the storefront after the app is uninstalled from store A | 3 | `extension-structure` (nothing written outside the embed) and `browser-layout` (no outside DOM, cookie or storage changes) | `RAMPSMITH_LIVE_AFTER_UNINSTALL=1 pnpm --filter @rampsmith/theme-app-ext-test exec vitest run test/live.test.ts` with `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_STORE_PASSWORD` |
| Reserved parameters a client adds to the storefront URL (each repeated and alone), with what the api receives recorded; stop if any client value arrives | 1, 3, 8 | `app-proxy-signature` duplicate-parameter tests | Builders add it with the api endpoint (ADR-162) |
| `X-Forwarded-For` shape and Railway edge log contents for the proxy path, recorded on staging | 8 | Per-shop limits stay authoritative until then | Builders add it with the api endpoint (ADR-162) |
| `metafieldsSet` on the app installation, then the link renders from `rampsmith.statement_url` | 1, 3 | `render` suite with the metafield stand-in | Builders add it with the statement publisher (ADR-163) |
| Whether Shopify serves the proxy under a locale prefix (`/fr/apps/…`) | 1, 3 | None needed until shown | Recorded during the proxy live check |
