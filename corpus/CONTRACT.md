# Corpus runner contract

How the theme test corpus (PLAN §23) is checked today, and how the integrated runner measures
the two R2 numbers against it: mapping accuracy and the patch engine's fix rate. Decisions and
evidence: ADR-201 (format), ADR-202 (renderer), ADR-203 (this contract), ADR-204 (browser
check), ADR-205 (findings for the architect). Code: `packages/corpus-tools`.

## Terms

- **Theme**: a directory under `themes/` laid out as a Shopify Online Store 2.0 theme. Every
  theme in this corpus is synthetic, written by hand for Rampsmith; no Dawn or other Shopify
  theme file is included (architect ruling, 17 Oct 2026).
- **Failing theme**: reproduces known failure patterns. **Control**: the failing theme's twin
  with every golden finding fixed (`twinOf`); it must produce no result at all.
- **Store**: fixture data (`fixtures/*.json`) a theme renders: shop, products and media,
  collections, pages, blog articles, menus, cart and search. `harbor` carries the data-audit
  failures; `harbor-clean` is the same store with them fixed, rendered by the controls.
- **Page**: one JSON template rendered with one store resource (`manifest.json`, `pages`).
- **Golden finding**: one entry of `golden/<subject>.json`. Its corpus-wide id is
  `<subject>/<id>`, for example `aurora/cart-link-name`.
- **Occurrence**: a page id (or `*` for every page of the theme) and a CSS selector; every
  element the selector matches on that page is one result node of the finding. `count` (default
  1) is how many elements it matches.
- **Span**: where the finding maps in source, in the unit `packages/liquid-patch` uses (ADR-101):
  UTF-16 code-unit offsets into the file as decoded from UTF-8, half-open.

| Span kind | Fields | Meaning |
| --- | --- | --- |
| `element` | `file`, `start`, `tag`, `anchor` | The element in a `.liquid` file whose start tag's `<` is at `start`: liquid-patch's `RecipeTarget` (ADR-102) plus the tag name |
| `json-value` | `file`, `pointer`, `start`, `end` | The value an RFC 6901 pointer names in a theme JSON file, such as a colour in `config/settings_data.json` or a section setting in `templates/index.json` |
| `css-declaration` | `file`, `selector`, `start`, `end`, `property`, `anchor` | One declaration inside the one rule with that selector, in a CSS asset or in a Liquid file's `{% stylesheet %}` |
| `data` | `resource`, `field`, optional `start`, `end`, `anchor` | Store data read through the Admin API, as a11y-rules' `DataLocation`: a GID, a field, and offsets into the field's value (`[0, 0)` for an empty field) |

Offset conventions, compared exactly: a JSON string value's span includes its quotes (the offsets
jsonc-parser reports for the value node); a CSS declaration's span runs from the property name to
the end of the value and excludes the `;`; an element span is the offset of the `<` only.

`anchor` is the source text at `start`, unique in the file (for a CSS declaration, unique in its
rule; a CSS rule is found by its whole selector, comments removed and whitespace collapsed). Reviewers read it; `pnpm --filter @rampsmith/corpus-tools run corpus spans --write` re-finds every offset from it after an
edit; mappers ignore it.

## Checks that run now (`pnpm --filter @rampsmith/corpus-tools test`)

ci.yml's node job runs them on every pull request (`pnpm -r test`, Node 26.12.0, pnpm 12.14.0).
Before Vitest starts, `scripts/ensure-chromium.ts` installs the Chromium headless shell bundled
with the locked playwright-core 1.64.1 when `CI=true`.

1. **Schemas.** `manifest.json` validates against `schema/manifest.schema.json` and every golden
   file against `schema/golden.schema.json` (JSON Schema 2020-12, Ajv 8.20.0 in strict mode). The
   schema enforces, among others: a control has no findings; a store has only data-audit findings;
   a theme has none; a refusal code exactly when the expected outcome is `refused`; `targeted`
   only for a theme patch expected to fix; `ambiguity` exactly when mapping is ambiguous.
2. **Rule ids.** Every `ruleId` is an axe-core 4.14.0 rule in the scanner's tags (`wcag2a`,
   `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; experimental rules excluded) or a custom rule of
   `@rampsmith/a11y-rules` (snapshot of `src/rules.ts` at `b79ba2f`). The finding's `engine`
   matches the rule's; its `criteria` equal the rule's WCAG 2.2 criteria (from axe-core's tags, or
   from the a11y-rules catalog); a custom rule's `impact` equals the catalog's.
3. **Spans.** Every span exists: an element span's offset is the start of an element with that
   tag name in the parsed file (`@shopify/liquid-html-parser` 2.10.2, walked as liquid-patch walks
   it) and its anchor is there and unique; a JSON span's offsets are the pointer's value; a CSS
   span's text is its anchor, a declaration of its property inside the one rule with its selector;
   a data span's field exists in the store and its offsets hold the anchor. The same holds for
   `rendersFrom`. The expected fix fits the span (`image-alt` on `<img>`, `form-label` on
   `<input>`, `<select>` or `<textarea>`, `document-language` on `<html>` in `layout/`, `contrast` on
   a JSON value or CSS declaration, and so on), and a targeted finding is in the six top
   categories, uses a deterministic recipe for them, and maps deterministically.
4. **Rendering.** Every theme stays inside Shopify's theme directories and every page renders with
   the pinned renderer (liquidjs 10.30.0 and the shim of ADR-202) without a missing translation.
5. **axe-core in Chromium.** Every page is rendered, served to Chromium through request
   interception (nothing leaves the process) at 1280×800, and checked with axe-core 4.14.0
   restricted to the scanner's tags. Per page, the set of `(rule, outcome, element)` result nodes
   must equal the set the golden occurrences name: every golden element is a node of its rule and
   outcome with the golden impact; every selector matches its `count`; no node is left
   unexplained; no element is claimed for one rule by two findings; every rule a golden finding
   names ran. A control must produce no violation and no incomplete result on any page.
6. **Custom rules.** For findings of engine `rampsmith-browser`, the occurrence selectors must
   match their counts now. Whether the rule fires is checked at integration, when
   `@rampsmith/a11y-rules` is in the workspace: run its check on the rendered page and require
   the same element set (docs/evidence/ws-11-corpus.md lists the step). Store findings
   (`rampsmith-data`) are checked the same way against the a11y-rules data audit.

## The integrated runner (R2)

### Inputs

For each failing theme and its store, the runner:

1. renders every page and scans it with the scanner of PLAN §11 (axe-core with the scanner's
   tags, plus the custom browser checks), and joins each scanner finding to a golden finding by
   rule, outcome and element, as check 5 does; a scanner finding with no golden finding fails the
   run;
2. gives each joined finding to the source mapper and records a **mapping record**
   (`schema/runner-records.schema.json`, `mapping`): `mapped` with a span and a confidence in
   [0, 1], `needs_review`, or `unmapped`; mappers need not send anchors or CSS selectors;
3. gives each finding whose expected fix is a theme patch to the patch engine with the mapped span
   (or, for refusal checks, the golden span) and applies every patch for the theme at once with
   `buildPatch` (liquid-patch);
4. re-renders and re-scans every page of the patched theme and records a **fix record** per
   finding (`fixes`): what the engine did (`edits`, `already-fixed`, or `refusal` with its code)
   and `stillFiring`, true when any of the finding's occurrences is still a node of its rule;
5. records each page's result counts before and after (`scans`) as `<ruleId>:<outcome>` → node
   count, with, after patching, `resolved`: per `<ruleId>:<outcome>`, the golden occurrence nodes
   that fired before and no longer fire; and the new Theme Check offenses per patched theme
   (`themeCheck`).

### Outputs

`buildReport` (`src/contract/metrics.ts`) turns the records into the report of
`schema/runner-report.schema.json`: both scores with a verdict per finding, the regressions, the
two gates and `passed`.

### Mapping accuracy

- **Denominator**: every golden finding whose `mapping` is not `none`, that is every rendered
  finding (data-audit findings carry their resource and field and need no mapping, PLAN §11).
- **Span equality**: same kind and same location: `element` by file, start and tag;
  `json-value` by file, pointer, start and end; `css-declaration` by file, start, end and
  property; `data` by resource, field, start and end. Anchors and selectors are not compared.
- **Correct**: `mapped`, confidence ≥ 0.9, span equal to the golden span.
- **Wrong above threshold**: `mapped`, confidence ≥ 0.9, span not equal. Mapping a finding whose
  colour or content is set elsewhere to the element it renders from (`rendersFrom`) is wrong: the
  fix is at the span, not the element (ADR-205, finding 8).
- **Not mapped**: confidence < 0.9 (right or wrong), `needs_review`, `unmapped`, or no record.
- **accuracy = correct / denominator**. The gate passes when **accuracy ≥ 0.95 and wrong above
  threshold = 0** (PLAN §23). A record for an unknown finding, two records for one finding, a
  `mapped` record without span or confidence, or a confidence outside [0, 1] is an error, not a
  score.

A finding marked `ambiguous` has more than one candidate with the same tag, static attributes and
classes; its `ambiguity` says what tells them apart. It stays in the denominator: the AI tie-break
of PLAN §12 may map it correctly at 0.9 or above, and must never map it wrongly at 0.9 or above.

### Fix rate

- **Targeted**: golden findings with `expectedFix.targeted`: a deterministic theme patch in the
  six top failure categories (low contrast, theme image alt text, form labels, empty links, empty
  buttons, document language) that is expected to fix the finding and maps deterministically.
- **Fixed**: targeted, the engine returned `edits`, and `stillFiring` is false after all of the
  theme's patches are applied.
- **fix rate = fixed / targeted**. A targeted finding with `already-fixed`, a refusal or no record
  counts as not fixed.
- **Expected refusals**: for a finding whose expected outcome is `refused`, the engine must refuse
  with the golden code; anything else, a missing record included, is listed under `unexpected` for
  a person to review (the golden file or the engine is wrong).
- **Other verdicts**: a finding expected `fixed` but not targeted (an ambiguous mapping, focus,
  target size) gets `fixed`, `still-firing`, `not-patched` or `missing` like a targeted one but does
  not count; findings with outcome `review` (AI proposals) or an Admin API channel are reported as
  `review`, never scored.

### Render regressions

A regression is any of:

1. a page that rendered before patching does not render after, or is not scanned after;
2. on any page, for any `(rule, outcome)` pair, the node count after patching differs from the
   count before minus `resolved`: higher is a **new result** (a pair that had no nodes, or a new
   node that replaced a resolved one), lower is an **unexplained drop** (checked content that
   vanished, such as markup swallowed by an unclosed tag);
3. a patched theme has new Theme Check offenses (liquid-patch `validateNoNewOffenses`).

Two scans of one page, or a page scanned only after patching, are errors, not regressions.
axe-core's view is the measure: a purely visual change that no rule sees is not detected.

The fix gate passes when **targeted > 0, fix rate ≥ 0.90 and regressions = 0** (PLAN §5, R2).

## Changing the corpus

- Add a theme: write it under `themes/<name>/` by hand (no third-party theme code), add it to
  `manifest.json`, scan it with `pnpm --filter @rampsmith/corpus-tools run corpus scan <name>`, write `golden/<name>.json` with
  anchors and `start: 0`, run `pnpm --filter @rampsmith/corpus-tools run corpus spans --write`, then Prettier, then the tests.
- Edit a theme file: run `pnpm --filter @rampsmith/corpus-tools run corpus spans --write` so offsets follow their anchors.
- A failing theme gets a control twin with every finding fixed, rendered with the clean store.
