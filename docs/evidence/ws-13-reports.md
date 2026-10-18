# Evidence: WS-13 reports and merchant statement generator (`packages/reports`)

Recorded in the Claude Code cloud environment on 18 October 2026 (Node 26.12.0, pnpm 12.14.0,
2 vCPUs). Branch `ws/reports` from `r0-foundations` at `16926b5`, with `r0-foundations` merged in
at `4181c3f` so the draft pull request could run `ci.yml`. Draft pull request:
https://github.com/billyribeiro-ux/rampsmith/pull/6 (do not merge; stream CI).

## 1. What was built

`packages/reports/`, a pure TypeScript package with **no runtime dependencies**:

| Module | What it does | ADR |
| --- | --- | --- |
| `src/statement.ts` | Merchant accessibility statement (R1): HTML document, store-page fragment (from h2), plain text; computed status `not_evaluated`, `known_barriers`, `no_known_barriers`; never "fully" | 221 |
| `src/remediation-log.ts`, `src/csv.ts` | Remediation log export: RFC 4180 CSV (one row per fix and finding, 22 columns, formula-injection guard) and versioned JSON | 224 |
| `src/summary.ts`, `src/charts.ts` | Executive summary: pass rate over time and open findings by impact, each an SVG figure with a text summary and a data table; key figures; coverage disclosure | 226 |
| `src/coverage.ts`, `src/wcag.ts`, `src/sections.ts` | Coverage disclosure (tested automatically / in part / needs a person) over the 55 WCAG 2.2 A and AA criteria; axe-core tag parsing; the axe-core 57% figure in every report | 225 |
| `src/pdf.ts`, `src/document.ts` | Tagged PDF with a document outline through an injected Chromium; isolated print (JavaScript off, fetch-nothing CSP, offline, dead proxy, request abort, fail closed) | 223 |
| `src/html.ts`, `src/escape.ts`, `src/blocks.ts`, `src/validate.ts` | Escaping by construction (`markup` tag, frozen private-field types), sanitizing, link validation, input validation with field names | 222 |
| `src/i18n.ts`, `messages/en.json` | Inlang-message-format catalog (the format `apps/web` uses), plural variants, locale fallback, catalog checker | 222 |
| `src/vocabulary.ts` | Enum spellings of `crates/domain` (tested against the Rust source) | 222 |

## 2. Dependencies, read from the live registry (18 October 2026)

```console
$ npm view playwright-core version dist-tags.latest engines license
{ "version": "1.64.1", "dist-tags.latest": "1.64.1", "engines": { "node": ">=20" }, "license": "Apache-2.0" }
$ npm view @sparticuz/chromium version engines license dependencies scripts
{ "version": "153.0.0", "engines": { "node": "^22.17.0 || >=24.0.0" }, "license": "MIT",
  "dependencies": { "tar-fs": "^3.1.2" } }      # no install or postinstall script
$ npm view axe-core version license
{ "version": "4.14.0", "license": "MPL-2.0" }
$ npm view pdfjs-dist version engines license optionalDependencies time.6.4.299
{ "version": "6.4.299", "engines": { "node": ">=22.13.0 || >=24" }, "license": "Apache-2.0",
  "optionalDependencies": { "@napi-rs/canvas": "^1.0.10" }, "6.4.299": "2026-10-03T16:47:40.337Z" }
$ npm view @napi-rs/canvas version scripts      # 1.0.11; no install script (prebuilt binaries)
$ npm view vitest version engines              # 5.0.5, the repository's pin
```

| Package | Version | Where | License | Why |
| --- | --- | --- | --- | --- |
| `playwright-core` | 1.64.1 | devDependency | Apache-2.0 | Launches Chromium in tests; the PLAN §7 pin. The package itself only declares a structural `PdfBrowser` interface, which the tests prove a Playwright `Browser` satisfies |
| `@sparticuz/chromium` | 153.0.0 | devDependency | MIT | Chromium 153.0.8010.0 for the browser suites in `ci.yml`'s node job, which installs no Playwright browser (ADR-223) |
| `axe-core` | 4.14.0 | devDependency | MPL-2.0 | axe on every HTML output; coverage derivation test |
| `pdfjs-dist` | 6.4.299 | devDependency | Apache-2.0 | Reads each PDF's structure tree, outline, title, language and text |
| `vitest` | 5.0.5 | devDependency | MIT | Repository pin |
| `@rampsmith/claims-lint`, `@rampsmith/tsconfig` | workspace | devDependency | — | The claims-lint CLI over every output; strict configs |

`pnpm-lock.yaml` changed only through `pnpm install`. `pnpm audit` (run by the security audit):
0 advisories across 490 workspace dependencies.

## 3. Facts verified for the design

- **Playwright PDF options** (`node_modules/playwright-core/types/types.d.ts`): `outline?: boolean`
  ("Whether or not to embed the document outline into the PDF"), `tagged?: boolean` ("Whether or
  not to generate tagged (accessible) PDF"); no `timeout` option. Playwright 1.64.1's
  `browsers.json` pins Chromium `156.0.8078.4`.
- **axe-core 4.14.0 README**, line 19: "With axe-core, you can find **on average 57% of WCAG issues
  automatically**." Cited in every report (PLAN §3).
- **axe-core 4.14.0 rule tags** (script `axe-cov.cjs`, output trimmed): 23 WCAG 2.2 A/AA criteria
  have at least one rule (1.1.1, 1.2.1, 1.2.2, 1.3.1, 1.3.4, 1.3.5, 1.4.1, 1.4.2, 1.4.3, 1.4.4,
  1.4.12, 2.1.1, 2.2.1, 2.2.2, 2.4.1, 2.4.2, 2.4.4, 2.5.3, 2.5.8, 3.1.1, 3.1.2, 3.3.2, 4.1.2);
  the other tags are AAA (1.4.6, 2.1.3, 2.2.4, 2.4.9, 3.2.5) or the removed 4.1.1. Level tags
  agree with the list in `src/wcag.ts` (3.1.1 `wcag2a`, 3.1.2 `wcag2aa`, 3.3.2 `wcag2a`,
  4.1.2 `wcag2a`, 1.3.4 `wcag21aa`, 2.5.8 `wcag22aa`).
- **WCAG 2.2** (W3C Recommendation 12 December 2024, read on w3.org): levels for 1.1.1 to 2.5.8
  and the criteria new in 2.2; 4.1.1 "obsolete and removed". 31 A + 24 AA = 55, asserted in
  `coverage.test.ts`.
- **Statement guidance**: W3C WAI statements page (updated 11 March 2021), the generator
  (updated 20 May 2025) and complete example; Commission Implementing Decision (EU) 2018/1523
  Annex; Directive (EU) 2019/882 Article 13(2) and Annex V. Quotes and links in ADR-221.
- **Inlang message format** (`@inlang/plugin-message-format` 4.5.4 README): simple messages with
  `{name}`, `\{` escapes; plurals as `[{ "declarations": ["input count", "local countPlural =
  count: plural"], "selectors": ["countPlural"], "match": { "countPlural=one": …,
  "countPlural=*": … } }]`.

### Chromium probes behind ADR-223

```console
$ node probe.tmp.mjs          # @sparticuz/chromium 153.0.0 + playwright-core 1.64.1
version 153.0.8010.0
bytes 15218 StructTreeRoot true Outlines true Marked true
--ash-no-nudges --disable-domain-reliability --disable-print-preview ... --allow-running-insecure-content
  --disable-setuid-sandbox --disable-site-isolation-trials --disable-web-security --headless='shell'
  --no-sandbox --no-zygote                       # chromium.args

# setContent with <iframe src="file:///…/secret.txt"> and <object data="file:///etc/hostname">
["--no-sandbox"] ok requests [] frames [ 'about:blank', '', '' ]
["--no-sandbox","--no-zygote","--single-process"] ok requests [] frames [ 'about:blank', '', '' ]
[chromium.args] ok requests [ 'file:///…/secret.txt', 'file:///etc/hostname' ]
  frames [ 'about:blank', 'file:///…/secret.txt', 'file:///etc/hostname' ]     # local files loaded

# --no-sandbox, offline context, route aborting everything; img/link/@import/url()/svg image
csp true  requests 6 [...]  routed 0     # CSP stops them before the network; request events still fire
csp false requests 6 [...]  routed 5     # without CSP the route aborts them
after refresh url chrome-error://chromewebdata/    # <meta refresh> navigates whatever the CSP says
```

### PDF structure (summary report, probe through pdfjs-dist)

```text
pages 4
info {"Language":"en","Title":"Accessibility summary for Example Goods","Creator":"Chromium","Producer":"Skia/PDF m153",...}
catalog: /MarkInfo <</Type /MarkInfo /Marked true>> /StructTreeRoot 33 0 R /Outlines 373 0 R
         /ViewerPreferences <</Type /ViewerPreferences /DisplayDocTitle true>> /Lang (en)
outline: Accessibility summary for Example Goods > Key figures, Automated pass rate over time,
         Open findings by impact, What the automated checks cover (> its three groups), About these results
struct tree: Document > H1, P, H2, L > LI, Figure > (Caption, Figure alt="Share of automated WCAG 2.2
         Level AA checks passed in each scan Line chart of 7 scans…", P), Table > (Caption, TR > TH/TD)
```

## 4. Tests

```console
$ cd packages/reports && npx vitest run
 Test Files  15 passed (15)
      Tests  240 passed (240)
   Duration  15.2s
```

| File | Tests | Covers |
| --- | ---: | --- |
| `spellings.test.ts` | 10 | Every enum spelling and order equals `crates/domain` (read from the Rust source) |
| `escape.test.ts` | 33 | HTML escaping, sanitizing (controls, bidi, invisible characters, separators), URL, email, phone validation, URL length cap |
| `csv.test.ts` | 19 | RFC 4180 quoting, formula guard at the start and after separators, BOM, CRLF, linear time on 32,000 separators |
| `i18n.test.ts` | 20 | Catalog parser (and its refusals), plurals, locale fallback, dates in UTC, HTML parameters, catalog parity |
| `coverage.test.ts` | 15 | WCAG 2.2 A/AA list (31 + 24), axe tag parsing, conservative derivation, axe-core 4.14.0 counts (23 partial, 32 manual) |
| `statement.test.ts` | 27 | Status logic, merging and ordering of barriers, wording that never claims full conformance, fragment and links, input refusals by field |
| `remediation-log.test.ts` | 17 | Verification result mapping, CSV columns and order, injection, cell cap, JSON format and escaping, input refusals |
| `summary.test.ts` | 16 | Palette contrast (4.5:1 text, 3:1 marks), key figures, chart summaries, data tables, ordering, refusals |
| `document.test.ts` | 6 | CSP hash equals the style sheet, policy contents, no script/img/link/style attribute, title and lang |
| `hostile.test.ts` | 7 | Hostile data in every field: only allowlisted elements and attributes, safe hrefs, inert CSV and JSON |
| `forgery.test.ts` | 12 | Look-alike `Html`, `Link`, `ReportDocument` refused; instances, classes and prototypes frozen; replaced array `map` ignored; system approver rebuilt; error quoting |
| `snapshots.test.ts` | 14 | Every output as a reviewable file in `test/__snapshots__/` |
| `claims.test.ts` | 2 | The claims-lint CLI over all 14 outputs (clean), and the same run failing on a planted claim |
| `axe.test.ts` | 11 | axe-core 4.14.0: zero violations on 6 documents and 3 store-page fragments; no incomplete result except colour contrast |
| `pdf.test.ts` | 31 | 6 documents printed: tagged, outline equals headings, title, `/Lang`, roles, Figure alt per chart, text; Letter size; forged document refused; hostile data prints inert with zero requests; 9 hostile markup vectors refused; meta refresh; scripts off; no URL in errors; deadline; each isolation layer alone; error wrapping; late context closed |

The repository gate, run locally on this branch after the merge of `r0-foundations`:

```console
$ pnpm install --frozen-lockfile        # Lockfile is up to date
$ pnpm run lint                          # eslint --max-warnings=0 . : no problems
$ pnpm run typecheck                     # every package, svelte-check 0 errors 0 warnings
$ pnpm run format:check                  # All matched files use Prettier code style!
$ pnpm knip                              # no findings (after pnpm --filter @rampsmith/web run sync)
$ node packages/claims-lint/src/main.ts  # claims-lint: 15 files scanned, no banned claims
```

`packages/reports/messages/en.json` is one of the 15 files: the repository's claims-lint already
includes `**/messages/**/*.json`.

## 5. CI on the pinned toolchains

- Run 39089310452 (head `740b9fb`): every job green except `node`, where 6 PDF tests failed
  because Chromium wrote outline titles without spaces on the runner's system fonts
  ("Accessibility statement for ExampleGoods"). The axe, isolation and every other suite passed,
  which also proved `@sparticuz/chromium` runs on `ubuntu-24.04`.
  https://github.com/billyribeiro-ux/rampsmith/actions/runs/39089310452
- Fix `fa31013`: the suites pin the Open Sans files `@sparticuz/chromium` ships through their own
  fontconfig file, and the style sheet turns ligatures off. Run 39093159786: **all 8 jobs green**
  (rust, node, e2e, contracts, images api/web/engine/egress).
  https://github.com/billyribeiro-ux/rampsmith/actions/runs/39093159786
- Final code commit `c32a6a2` (after the re-audit fixes and the not-evaluated wording): run
  39094308163, **all 8 jobs green**.
  https://github.com/billyribeiro-ux/rampsmith/actions/runs/39094308163

## 6. Security audit

The `security-auditor` agent definition is on `main` only, so the audit ran as a general-purpose
agent given that definition's instructions, at effort max, over the escaping and the PDF path.
Verdict **PASS** (no critical or high findings). It fuzzed 2,801 hostile inputs through
Chromium's own parser, ran 53 hostile markup vectors through the printer with and without the
CSP and with `chromium.args`, watched HTTP requests, TCP connections and a Chromium net log
(zero in the intended configuration), and checked every regular expression for backtracking.
Findings and fixes (commit `68768fa`, ADRs updated in `709567a`):

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | Medium | URLs had no length cap; percent-encoding grows them ninefold and a huge URL stalled or crashed the shared printer | Cap at 2,048 characters as typed and as serialized |
| 2 | Medium | CSV guard looked only at the start of a field; Excel in `;` locales may split inside quotes | Apostrophe before a formula character after `,` `;` tab or line break inside a field |
| 3 | Low | `<link rel=prefetch>` passes Playwright routing; with offline dropped the isolation leaned on one layer | Dead proxy covering loopback; tests prove CSP, offline and proxy each stop every vector alone |
| 4 | Low | `ReportDocument` and the internal `Html` and `Link` could be forged with `Object.create` | Frozen, private fields, private-field brand checks; look-alike objects refused |
| 5 | Low | JSON copied a system approver object as given | Rebuilt field by field |
| 6 | Low | Some errors echoed raw input; browser errors were rethrown raw; deadlines did not cover every step | `quote()` (40 characters, one line); every failure is `ReportRenderError` naming only the step and the error class; one deadline for the whole print; late contexts closed |
| 7 | Low | U+2028/U+2029 passed single-line fields; zero-width characters kept | Line separators become LF (so single-line fields refuse them); U+200B, U+2060–U+2064, U+FEFF stripped; joiners and direction marks kept for Persian, Indic scripts, emoji and RTL |
| 8 | Low | `@sparticuz/chromium` reuses any `chromium` in the temporary directory | Test setup unpacks into a fresh private directory per run |

**Re-audit of the fixes** (same agent, same rules): findings 1 to 8 **FIXED**, with reproductions
re-run (2,546 more fuzz cases, the 53 printer vectors under both launch argument sets, hung
`setContent` and `close`). It found one regression and three residual lows, all fixed in the
commit after `fa31013`:

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 9 | High | The new separator regex `([,;\t\n])(\s*)(…)` overlapped `\s*` with tab and line feed and backtracked quadratically: 32,000 tabs took 2.4 s per cell, 10 such fixes blocked the event loop for 46.7 s | `([^\S\t\n]*)`, identical output on 200,000 random strings and under 1 ms on the worst case; a test bounds 32,000 tabs, line feeds, semicolons or spaces under 100 ms |
| 10 | Low | `render()` and `join()` called an array's own `map` | `Array.from(value, render)` |
| 11 | Low | `ReportDocument.prototype` (and `Html`, `Link`) not frozen: overriding a getter or `is` would print other markup | Classes and prototypes frozen; tested |
| 12 | Low | `quote()` left bidirectional and invisible characters raw | Escaped as `\u` sequences |

## 7. Integration notes (for the integrator; this stream edited none of these files)

- **Shared files:** none needs a change for CI: `ci.yml`'s node job runs `pnpm -r test`, which runs
  the browser suites on `@sparticuz/chromium`. If a browser job is added later, set
  `CHROMIUM_EXECUTABLE_PATH` to Playwright's Chromium and the devDependency can go.
- **ADR index** (`docs/adr/README.md`): add ADR-221 to ADR-226.
- **PLAN corrections**, each written out in its ADR: §3 claims table row and §5 R1 statuses
  (ADR-221); §8 layout and the `{@html}` rule (ADR-222); §16 PDFs and §18 threats (ADR-223); §16
  remediation log and §9 repository needs (ADR-224); §11 coverage disclosure (ADR-225); §16
  summary and §9 `scans` columns (ADR-226).
- **`docs/ENVIRONMENT.md`** (on `main`): its Chromium row says to launch with
  `args: chromium.args`. Those arguments include `--disable-web-security`, under which a page
  loaded local files in the probe above. Replace with `args: ['--no-sandbox']` (ADR-223).
- **Database (main builder):** `db::repo::fixes::Fix` does not return `verified_scan` or
  `reverts`; the export also needs the verification scan's `finished_at` and the approver's
  display name (ADR-224). `scans` has no `checks_run` or `checks_passed` (ADR-226). No migration
  was added here.
- **Engine:** pass the engine's browser (launched with `chromiumSandbox: true`) to `renderPdf`, or a
  dedicated one; never launch it with `--disable-web-security`. The image that prints reports needs
  real fonts and should repeat the outline check (ADR-223). Feed `coverageFromRules` with the
  ruleset's rules (`axe.getRules()` tags through `criteriaFromAxeTags`, plus the custom catalog);
  `packages/engine/src/wcag.ts` `criteriaFromTags` keeps AAA criteria, which the reports filter.
- **Web app:** the store-page fragment is safe to render with the one sanitized `{@html}` component
  (ADR-222). Finding summaries for other locales come from the caller.
- **Personal data:** the remediation log carries approvers' display names because it is the
  merchant's own record; nothing in the package logs.

## 8. Final state

- Code: `c32a6a2` on `ws/reports`; 15 test files, 240 tests, all passing locally (Node 26.12.0,
  pnpm 12.14.0) and in CI run 39094308163 on the pinned toolchains (green).
- The commit after it adds only this section; the STATUS.md row on `main` names that head and
  its run.
- ADRs: 221 (statement), 222 (package and escaping), 223 (isolated tagged PDF), 224 (remediation
  log), 225 (coverage disclosure), 226 (summary and charts). 227 to 229 are unused.
- Draft pull request #6 into `r0-foundations`, never to be merged; `r0-foundations` was merged in
  at `4181c3f`, so the pull request has no conflict with its base at `4fdfb3b`.
