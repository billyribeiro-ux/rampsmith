# WS-11 evidence: theme test corpus (synthetic themes only)

- Stream: WS-11, branch `ws/corpus` (from `r0-foundations` at `16926b5`, with `r0-foundations`
  merged in at `a90ff4a`), draft pull request #2 into `r0-foundations` (stream CI only; never merged)
- Session: https://claude.ai/code/session_01JmMru56F8bzLPTMk2jxmxe
- Owned paths: `corpus/`, `packages/corpus-tools/`; ADRs 201 to 205
- Dates: 17 and 18 Oct 2026 (UTC)

## What was built

**Themes** (all written by hand for Rampsmith; no Dawn or other Shopify theme file, per the
architect's ruling):

| Theme | Kind | Store | Pages | Golden findings | Targeted | Files |
| --- | --- | --- | --- | --- | --- | --- |
| aurora | failing | harbor | 8 (all eight R1 page types) | 19 | 17 | 40 |
| birch | failing | harbor | 5 | 16 | 13 | 25 |
| cedar | failing | harbor | 4 | 13 | 5 | 37 |
| aurora-clean | control, twin of aurora | harbor-clean | 8 | 0 | 0 | 40 |
| birch-clean | control, twin of birch | harbor-clean | 5 | 0 | 0 | 25 |
| cedar-clean | control, twin of cedar | harbor-clean | 4 | 0 | 0 | 37 |

**Stores**: `harbor` (`fixtures/store.json`) with 5 data-audit golden findings
(`golden/store-harbor.json`); `harbor-clean` (`fixtures/store-clean.json`) with none.

**Golden findings: 53** (48 rendered in themes, 5 store data), **35 targeted** by the patch engine.

| Category (PLAN §12) | Findings | Targeted | Rules |
| --- | --- | --- | --- |
| Low contrast text (1.4.3) | 5 | 5 | `color-contrast` from a global setting, a section setting in a JSON template, a `.css.liquid` setting, a CSS asset, a section `{% stylesheet %}` |
| Missing alt text, theme images (1.1.1) | 5 | 4 | `image-alt` (`image_url`, `img_url`, `data-src`, `srcset`; one asset image refused `no-image-object`) |
| Missing alt text, product media (1.1.1) | 2 | 0 | `rs-media-alt-empty`, `rs-media-alt-filename` (Admin API data fix) |
| Missing form labels (4.1.2) | 7 | 7 | `label` (email, password, search, number, textarea), `select-name` |
| Empty links (2.4.4, 4.1.2) | 10 | 8 | `link-name` (icon snippets, inline SVG, icon fonts, `alt=""` image, `inline_asset_content`; one refused `dynamic-content`, one ambiguous) |
| Empty buttons (4.1.2) | 8 | 8 | `button-name` (icon snippets, `aria-label=""`, single-quoted attributes, inlined SVG) |
| Missing document language (3.1.1) | 3 | 3 | `html-has-lang` (no `lang`, `lang=""`, password layout) |
| No skip link (2.4.1) | 1 | 0 | `bypass` (incomplete; recipe refuses `main-landmark-not-found`) |
| Invisible focus (2.4.7) | 1 | 0 | `rs-focus-indicator-missing` |
| Small targets (2.5.8) | 1 | 0 | `target-size` |
| Skipped headings, vague links, rich-text images | 4 | 0 | `rs-rich-text-heading-skip`, `rs-rich-text-link-vague`, `rs-rich-text-img-alt-missing`, `image-alt` on article content |
| Custom widget roles and states (4.1.2, 1.3.1) | 4 | 0 | `aria-required-parent`, `aria-required-children`, `listitem`, `aria-valid-attr-value` |
| Other | 2 | 0 | `frame-title`, `link-in-text-block` |

Span kinds: 39 element, 5 CSS declaration, 3 JSON value, 1 data (rendered), plus 5 data (store).
Mapping: 47 deterministic, 1 ambiguous (birch's duplicated cart link), 5 none (data audit).

**Package `@rampsmith/corpus-tools`**: JSON Schemas and Ajv validation for golden files, the
manifest and the runner's records and report; the rule catalog (axe-core 4.14.0 in the scanner's
tags, plus a snapshot of a11y-rules' 19 custom ids); span verification against the Liquid AST,
JSON pointers, CSS rules and fixture data; semantic golden checks; the static renderer (liquidjs
10.30.0 and a Shopify shim); the browser check (axe-core in Chromium, exact match per page); the
runner contract's scoring (`src/contract/metrics.ts`); and a CLI (`render`, `scan`, `spans`).

Dependencies, each checked with `npm view` on 2026-10-17: `liquidjs` 10.30.0 (MIT),
`ajv` 8.20.0 (MIT), `jsonc-parser` 3.3.1 (MIT), `@shopify/liquid-html-parser` 2.10.2 (MIT),
`axe-core` 4.14.0 (MPL-2.0, already locked), `playwright-core` 1.64.1 (Apache-2.0, already
locked), `vitest` 5.0.5 (dev). Declared in `packages/corpus-tools/package.json`; the lockfile
changed only through pnpm.

## Gates (local: Node 26.12.0, pnpm 12.14.0, Chromium 153 from `@sparticuz/chromium`)

```text
$ pnpm --filter @rampsmith/corpus-tools test
ensure-chromium: using /tmp/chromium
 Test Files  9 passed (9)
      Tests  153 passed (153)

$ pnpm exec eslint --max-warnings=0 packages/corpus-tools      # no output
$ pnpm --filter @rampsmith/corpus-tools typecheck              # no output
$ pnpm exec knip --workspace packages/corpus-tools             # no output
$ pnpm exec prettier --check .
All matched files use Prettier code style!
$ node packages/claims-lint/src/main.ts
claims-lint: 13 files scanned, no banned claims
```

Test files: `metrics` (29, written before the scoring code, the review's additions included),
`compare` (8, written before the comparison code), `schema` (10), `rules` (7), `spans` (18),
`render` (9), `corpus` (47 static
checks: every golden verifies, every page renders), `browser` (21: per theme, exact axe-core match,
every golden rule ran, custom-rule selectors resolve, controls produce zero results), `contract`
(4: records and report validate; an oracle passes both gates; today's recipes alone fail the fix
gate).

## CI on the pinned toolchains (ci.yml through draft pull request #2)

- [Run 39089657516](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39089657516) on
  `585339e`, the last code commit (review fixes, 153 tests): all 8 jobs green.
- [Run 39087766684](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39087766684) on
  `3620472`: all 8 jobs green (rust, node, e2e, contracts, images api, egress, engine, web). The
  node job installs Chrome Headless Shell 156.0.8078.4 for the locked playwright-core and runs the
  corpus tests, browser check included, on Node 26.12.0.
- [Run 39087288762](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39087288762) on
  `a90ff4a`: node job green, log shows `Downloading Chrome Headless Shell 156.0.8078.4 ...` and
  `packages/corpus-tools test: Tests 91 passed (91)` with `test/browser.test.ts (6 tests)`.
- [Run 39088109891](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39088109891) on
  `98fb402` (documents, runner schemas, contract test): all 8 jobs green.
- Run 39087288762's overall status is `cancelled` (a later push cancelled its `images (engine)`
  job); its node job had passed.
- Earlier runs 39085567385 and 39086937255 failed at `pnpm install --frozen-lockfile` with
  `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`: `r0-foundations` had moved past `16926b5`, and the merge
  ref combined two lockfiles. Fixed by merging `r0-foundations` into the branch and regenerating
  the lockfile with `pnpm install` (`a90ff4a`). No failure outside this stream's paths.

## Recipe probe: liquid-patch at `551b200` on the corpus

The six recipes of `packages/liquid-patch` (source read with `git show
origin/ws/liquid-patch:packages/liquid-patch/src/...` into the scratchpad, not committed here)
were run on every golden element finding of the failing themes with the golden parameters; their
edits were applied with `applyEdits`, their translation keys added to every storefront locale,
and every page re-rendered and re-scanned in Chromium, with the exact regression accounting of
CONTRACT.md (`resolved` per rule and outcome):

```text
aurora: targeted 17, fixed 15
   not fixed: announcement-contrast engine=none stillFiring=true
   not fixed: featured-description-contrast engine=none stillFiring=true
   regressions: []
birch: targeted 13, fixed 11
   not fixed: announcement-contrast engine=none stillFiring=true
   not fixed: card-vendor-contrast engine=none stillFiring=true
   non-targeted edited: desktop-cart-link-name stillFiring=false
   regressions: []
cedar: targeted 5, fixed 4
   not fixed: newsletter-note-contrast engine=none stillFiring=true
   regressions: []
TOTAL fixed 30/35
```

Every element finding got the recipe outcome its golden expects (`edits`, or the refusals
`dynamic-content`, `no-image-object` and `main-landmark-not-found`). The 5 unfixed findings are the
low-contrast ones, for which liquid-patch has no recipe yet.

## Independent review

A fresh-context review of the branch (read-only subagent) checked the contract against the code,
the pure logic, the goldens against ADR-102, and every count. Acted on: exact regression
accounting with `resolved` (a swapped node and swallowed content are now regressions), duplicate
or after-only scans as errors, malformed mapping records rejected for every finding, verdicts for
untargeted fixes and missing refusals, duplicate claims in the page comparison, CSS rules matched by
whole selector with comments and Liquid skipped and declarations not matched inside longer
properties, JSON pointers resolving all-digit object keys, zero-length data spans with a11y-rules'
offsets for media alt text, anchors and selectors optional for mappers, birch's CRLF stored byte
for byte (`-text`), `spans --write` leaving a file alone when a span cannot be re-found, refusal
codes checked against each recipe, documented offset conventions, the mapper's non-element
targets recorded in ADR-205 with a plan correction, and corrected wording on CI runs, anchors and
2.4.1. No mismatch was found between the goldens and liquid-patch's recipe rules, and no banned
claim.

## ADRs

- ADR-201: synthetic corpus, golden format, span format, fixture stores, section ids
  (Shopify docs cited); **plan correction** for PLAN §23.
- ADR-202: static renderer (liquidjs 10.30.0 and the Shopify shim).
- ADR-203: runner contract: mapping accuracy, fix rate, render regressions; **plan correction**
  for PLAN §5 R2.
- ADR-204: browser check with axe-core 4.14.0 in Chromium inside ci.yml's node job.
- ADR-205 (proposed): findings for the architect and the integrator; **plan corrections** for
  PLAN §12 (mapping step 5 for non-element targets, skip link row, form-label criteria).

## Alignment with the sibling streams

- **ws/a11y-rules at `b79ba2f`**: all 19 custom rule ids, audits, criteria and impacts copied into
  `CUSTOM_RULES` (`src/rules.ts`); no mismatch. axe-core rule ids are read from axe-core 4.14.0.
- **ws/liquid-patch at `551b200`**: element spans are `RecipeTarget` (`{file, start}` at the
  `<` of the start tag, UTF-16 code units) plus the tag; elements are found by walking the AST as
  `src/html.ts` does. Recipe ids, parameter shapes (`label: {key, text}`, `visuallyHiddenClass`,
  `id`, `decorative`) and `RefusalCode` are copied into `src/golden.ts`. Mismatches and gaps:
  (a) there is no contrast recipe, so the 5 low-contrast targeted findings cannot be fixed and the
  best reachable fix rate is 30/35 = 85.7% (`test/contract.test.ts`); (b) `RecipeTarget` covers
  elements only, while contrast, focus and target-size fixes act on JSON values and CSS
  declarations, which the corpus records as `json-value` and `css-declaration` spans.

## Integration notes (what the integrator moves into shared files)

1. `docs/adr/README.md`: add ADR-201 to ADR-205.
2. PLAN corrections: ADR-201 (§23 corpus bullets), ADR-203 (§5 R2 cell), ADR-205 (§12 mapping
   step 5, skip-link row and form-label criteria).
3. Replace `CUSTOM_RULES` in `packages/corpus-tools/src/rules.ts` with an import of `RULES` from
   `@rampsmith/a11y-rules`, and `RECIPES`, `BUILT_RECIPES` and `REFUSAL_CODES` in `src/golden.ts`
   with imports from `@rampsmith/liquid-patch`, adding both as workspace dependencies.
4. Close CONTRACT.md check 6 once `@rampsmith/a11y-rules` is in the workspace: run
   `checkKeyboard`/focus checks on birch's pages for `birch/btn-focus-outline`, and the data
   audit on `fixtures/store.json` for the 5 findings in `golden/store-harbor.json`, requiring the
   same elements and locations (media alt text as `{start: 0, end: alt.length}`, as `auditMediaAlt`
   reports it). Until then those 6 findings are verified for selectors, spans and fixture data only,
   not for the rule firing.
5. Build the integrated runner of CONTRACT.md: mapper and patch engine records in, `buildReport`
   out; `test/contract.test.ts` shows the expected shapes.
6. Nothing else in shared files is needed: knip, ESLint, Prettier, claims-lint and `ci.yml`
   already cover the package as written. An explicit `playwright-core install --only-shell
   chromium` step in the node job could replace the install in `scripts/ensure-chromium.ts` if the
   integrator prefers it in the workflow.
