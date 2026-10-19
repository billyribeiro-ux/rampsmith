# ADR-161: Theme app extension: one app embed, statement link and barrier-report form

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-7 (`extensions/theme-app-ext/`, `packages/theme-app-ext-test/`)

## Context

PLAN §14 "Theme app extension": one app embed, off by default, with an "Accessibility" footer
link to the published statement and an optional barrier-report form that posts through a signed
app proxy; under 5 KB of deferred JavaScript; no layout shift; uninstalling leaves nothing in the
theme. PLAN §23 repeats the 5 KB budget. CLAUDE.md never allows theme writes (ADR-004) or an
overlay or toolbar widget.

Checked on shopify.dev on 17 and 18 October 2026:

- [Theme app extension configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration):
  the extension is `assets/`, `blocks/`, `snippets/`, `locales/` and `shopify.extension.toml`
  (`name`, `type = "theme"`, optional `handle`). An app embed block's schema takes `name` (under
  25 characters), `target` (`head`, `body` or `compliance_head`), optional `javascript` (loaded
  with `<script async>` in the head), `stylesheet`, `enabled_on`/`disabled_on`, `settings` and
  `available_if`. "By default, app embed blocks are deactivated after an app is installed";
  merchants enable them under Theme settings > App embeds, or through a deep link
  `https://<shop>/admin/themes/current/editor?context=apps&template=<t>&activateAppId=<api_key>/<handle>`.
  Embeds see only the page's global Liquid scope; `content_for_header`, `content_for_index` and
  `content_for_layout` are not available. Locale files: storefront strings in `*.json`
  (merchants cannot edit them), editor strings in `*.schema.json`; at most 100 files of 15 KB.
  Enforced limits: 10 MB in all, 30 blocks, 100 KB of Liquid. Suggested: 10 KB of compressed
  schema JavaScript, 100 KB of CSS. JSON may not contain comments or trailing commas.
- [UX guidelines](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/ux):
  limit settings to visual ones; on uninstall "blocks associated with the apps are automatically
  and entirely removed from online store themes."
- [Storefront locale files](https://shopify.dev/docs/storefronts/themes/architecture/locales/storefront-locale-files):
  `t` escapes its output unless the key ends in `_html`.
- [Liquid `request`](https://shopify.dev/docs/api/liquid/objects/request): `design_mode`,
  `locale`, `page_type`, `path`; "You shouldn't use `request.design_mode` to change
  customer-facing functionality."
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements):
  5.1.1 (modify themes only through theme app extensions), 5.1.2 (no errors in the theme editor
  or storefront), 5.1.3 (setup instructions; a deep link is strongly recommended), 5.1.4 (app
  name branding in storefront components only where customers interact with it as part of
  buying), 5.1.5 (customer data collected on the Online Store is returned to the merchant's
  Shopify admin).
- [Theme Check configuration](https://shopify.dev/themes/tools/theme-check/configuration):
  `extends: theme-check:theme-app-extension`.

Read from the source bundled in Shopify CLI 4.9.4 (the PLAN §7 pin), 17 October 2026: the CLI
deploys the files matching `*/*` in the extension (ignoring `.git`, `node_modules`, `*.toml`,
`.DS_Store` and a few editor files), refuses any directory other than `assets`, `blocks`,
`locales` and `snippets`, allows `.jpg .jpeg .json .js .css .png .svg .wasm` in `assets`,
`.liquid` in `blocks` and `snippets` and `.json` in `locales`, and checks 10 MB in all and
500 KB of Liquid (the documentation's 100 KB is stricter, and the tests hold that one). Files at
the extension root other than the TOML are never uploaded.

## Decision

1. **Files.** `extensions/theme-app-ext/`: `shopify.extension.toml` (`name` and `handle`
   `rampsmith-accessibility`, `type = "theme"`), `blocks/accessibility.liquid` (the embed; its
   handle for the deep link is `accessibility`), `snippets/rampsmith-a11y-styles.liquid`,
   `snippets/rampsmith-barrier-report.liquid`, `assets/rampsmith-barrier-report.js`,
   `locales/en.default.json` and `locales/en.default.schema.json`. Two root-level files serve the
   tooling only and are never deployed: `.theme-check.yml` (`extends:
   theme-check:theme-app-extension`) and `tsconfig.json` (type-checks the script as JavaScript
   with `checkJs`, so ESLint's typed rules apply to it).
2. **One embed, `target: "body"`, off by default.** Shopify ships embeds deactivated; the
   schema has no `enabled_on`, no `javascript` and no `stylesheet`, so an enabled embed costs no
   request on pages where it renders nothing. Settings: show the link (default on), a statement
   URL override, show the form (default off), and a colour scheme (theme colours, dark text on
   white, white text on dark).
3. **Markup.** A labelled `<aside>` (complementary landmark, so axe's region rule holds on any
   theme) rendered just before `</body>`: a link to the statement and, when enabled, a `<details>`
   disclosure holding the form. Rendering at the end of the body, in the server HTML, is what
   keeps it free of layout shift: nothing is inserted after load. It is not moved into the
   theme's own footer, which would need script and would shift the page. When neither part has
   anything to show it renders nothing; in the theme editor only, it shows a merchant notice
   instead (merchant-facing, so the `design_mode` caution does not apply).
4. **Statement URL.** The embed setting if set, else the app-data metafield
   `rampsmith.statement_url` (ADR-163), and only if it starts with `https://` or a single `/`.
   No usable URL, no link.
5. **No JavaScript needed.** `<details>` opens the form, the browser validates `required`,
   `maxlength` and `type="email"`, and the form posts to the app proxy (ADR-162). The script
   adds in-page sending with `fetch`, inline errors linked by `aria-describedby`, focus on the
   first problem, `aria-invalid`, a `role="status"` line, `aria-disabled` while sending (never
   `disabled`, which would drop focus), and one request per press. It is loaded with `<script
   defer>` from `asset_url`, only when the form is shown: 4,743 bytes uncompressed, 1,830 gzip.
   It writes no cookie or storage and changes nothing outside its form.
6. **Strings.** Every visible string, attribute label and script message is in
   `locales/en.default.json`; the script reads its messages from `data-msg-*` attributes. No key
   ends in `_html` and no string contains HTML, so `t`'s escaping is always right; `t` output is
   never piped through `escape` again (that would double-escape). English ships first; more
   locales are files added beside it (PLAN §8).
7. **Styling.** Under 2 KB of CSS inlined in a `<style>` element, scoped to `.rs-a11y`, so the
   embed adds no request and no render-blocking stylesheet. Targets are 44 px tall; borders and
   focus rings use `currentColor`; the fixed schemes are #1f1f1f/#fff with errors #b3261e and
   #ffb4ab (all at least 4.5:1); the error and status lines keep one line of space while empty;
   nothing animates.
8. **Data minimisation.** The form sends the page type and locale with the report, and the
   path only for public page types; account, gift card, password and challenge pages send their
   type alone, because their paths can carry order numbers or gift card codes. The description hint asks shoppers to leave out payment, health and other personal
   details. No app branding appears on the storefront (requirement 5.1.4).
9. **Uninstall.** The extension holds no theme files: Shopify removes the embed with the app.
   Nothing else is written anywhere in the theme or the browser.

## Consequences

- Theme Check runs on the Liquid docs bundled with `@shopify/theme-check-node` 3.30.1 (revision
  `40f966fc` of Shopify/theme-liquid-docs), never a download of that repository's `main`
  (CLAUDE.md: no floating references); see ADR-164.
- If a merchant moves the app proxy (the admin's "Customize URL"), the form follows only once
  the api writes `rampsmith.proxy_path` (ADR-163).
- Requirement 5.1.5 is met by showing every report in the embedded App Home and its export;
  Rampsmith creates no Shopify customer records (it requests no customer scopes). This reading
  goes on the App Review checklist.
- Live checks on a development store are in LAUNCH.md section E rows proposed in the evidence
  file: rendering, axe, the served script size, a report through the live proxy, and a storefront
  with no trace after uninstall.

## Plan correction

PLAN §14 "Theme app extension", replace the paragraph with:

> One app embed (`blocks/accessibility.liquid`, target `body`), off until the merchant enables
> it (Shopify ships embeds deactivated; the app gives a deep link). It renders, at the end of
> the page, a labelled region with an "Accessibility" link to the published statement and, if
> the merchant turns it on, a barrier-report form that posts through the signed app proxy
> (ADR-162). The form works without JavaScript; a deferred script under 5 KB, loaded only with
> the form, adds in-page sending and inline errors. Nothing is inserted after load, so it causes
> no layout shift, keeping the Built for Shopify storefront impact well under 10 Lighthouse
> points. Every string is in the extension's locale files. Shopify removes the embed on uninstall,
> and the extension writes nothing else (ADR-161).

PLAN §14 "App Review checklist", add: "- [ ] Barrier reports visible to the merchant in the
embedded app (requirement 5.1.5); no app branding on the storefront (5.1.4); embed setup
instructions with the activation deep link (5.1.3)".

PLAN §7 "Engine" table: Theme Check is `@shopify/theme-check-node` 3.30.1 and also lints the
theme app extension, with `extends: theme-check:theme-app-extension`.
