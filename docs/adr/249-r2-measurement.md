# ADR-249: R2 measurement: the engine against the corpus, before and after

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`)

## Context

R2's exit criterion (PLAN §5) is "the patch engine fixes at least 90% of targeted findings on the
theme test corpus with zero render regressions", with mapping at the corpus contract's bar
(ADR-203: 95% correct at confidence 0.9 or more, none wrong at 0.9 or more). WS-11 measured the
engine before this work at 30 of 35 targeted findings (85.7%) and had no mapper to measure. This
ADR records what the measurement is, its result, and what it does not show.

## How it is measured

`pnpm --filter @rampsmith/corpus-tools exec node src/cli.ts run` (and the test
`test/runner.test.ts`, ADR-247) on Node 26.12.0 with Chromium 1280×800 and axe-core 4.14.0.
Three configurations, each a full run of the three failing themes (aurora, birch, cedar):

- **A, before:** the golden span is the target and the engine has no contrast recipe
  (`--golden-spans`, `withoutRecipes: ['color-contrast']`). This reproduces WS-11's 30 of 35.
  There was no mapper: mapping 0 of 48.
- **B, recipes alone:** golden spans, all recipes (the contrast recipe of ADR-242 added).
- **C, after:** the mapper's spans, all recipes (the default run).

## Result

| | A, before | B, recipes alone | C, after |
| --- | --- | --- | --- |
| Mapping: correct at 0.9 or more / needing mapping | 0 / 48 (no mapper) | not run | **48 / 48** |
| Mapping: wrong at 0.9 or more | 0 | not run | **0** |
| Targeted findings fixed / targeted | 30 / 35 (85.7%) | 35 / 35 | **35 / 35 (100%)** |
| Render regressions (ADR-203) | 0 | 0 | **0** |
| New Theme Check offenses | 0 | 0 | **0** |
| Unjoined scanner findings or count mismatches | 0 | 0 | **0** |

By category (C; the same rows for A differ only in low contrast, 0 of 5 fixed in A):

| Category | Findings | Mapped correctly | Targeted | Fixed |
| --- | --- | --- | --- | --- |
| low-contrast | 5 | 5 | 5 | 5 (A: 0) |
| alt-text-theme-image | 5 | 5 | 4 | 4 |
| form-label | 7 | 7 | 7 | 7 |
| empty-link | 10 | 10 | 8 | 8 |
| empty-button | 8 | 8 | 8 | 8 |
| document-language | 3 | 3 | 3 | 3 |
| focus-visible | 1 | 1 | 0 | no recipe, reported |
| target-size | 1 | 1 | 0 | no recipe, reported |
| skip-link | 1 | 1 | 0 | refused as expected (`main-landmark-not-found`) |
| widget-roles | 4 | 4 | 0 | review (AI proposal) |
| rich-text | 1 | 1 | 0 | review (Admin API channel) |
| other | 2 | 2 | 0 | review |
| **All** | **48** | **48** | **35** | **35** |

The five store-data findings (`harbor`) need no mapping and are reviewed through the Admin API.
Three findings are expected refusals and refuse with the golden code: `aurora/mug-card-link-name`
(`dynamic-content`), `birch/payment-visa-alt` (`no-image-object`), `cedar/password-bypass`
(`main-landmark-not-found`). The lowest mapping confidence is 0.94. `docs/evidence/ws-14-patch-r2.md`
lists every finding with its span, confidence and verdict.

## Corpus corrections

None. No golden file or theme was changed (`git diff 6eb635a -- corpus` is empty). The mapper found
every golden span the way the contract defines it, including the nine non-element ones, and the
mapper-found spans are byte-equal to the golden offsets.

## What the result does not show

- **The mapper and the corpus were developed together.** The corpus has 53 goldens in three
  themes; the mapper's rules were written while reading those themes. 100% here is not an
  estimate of accuracy on a merchant's theme. The independent evidence is the second, hand-written
  theme in `test/tarn.ts` and the tests built on it, which exercise the doubtful branches (two
  equal candidates, a render too dynamic to follow, a setting that disagrees with the page, a
  colour that is not the one measured, rules the model cannot decide) and expect a score below
  0.9 there. A later release should re-measure on themes written by someone else.
- **Parameters come from the golden file.** Label texts, keys and decorative reasons are the
  golden's `expectedFix.params`, standing in for the merchant or the AI proposal.
- **Regressions are axe-core's view** (ADR-203). A purely visual change that no rule detects is
  not seen. The edits are span edits that keep every other byte (`test/recipe-properties.test.ts`),
  and every patched file re-parses and passes Theme Check, which bounds what an edit can change,
  but it is not a pixel comparison.
- **One browser, one viewport.** Chromium at 1280×800; the cascade model evaluates media queries
  there. A fix for a mobile-only rule is not exercised.
- **Mapping limits** (ADR-244, ADR-245): elements created by JavaScript, text printed through
  filters in a way that changes it, cascade layers, `@scope`, container queries, nesting and
  shadow DOM are not modelled; they come back below 0.9 or `unmapped`, not wrong, by design, but
  the corpus has no example of each.
- **Contrast measure from the first node.** A finding with several nodes (the corpus's contrast
  findings have 1 to 9) takes the background and text size from the first. The rescan checks every
  node and none fires, but a theme whose nodes sit on different backgrounds could need a
  worst-case choice that the runner does not make.

## Consequences

- R2's exit criterion is met on the corpus as defined, by tests that fail below the bar (ADR-247).
- The founder's inputs (LAUNCH.md section C) are not needed for any of this.
- The numbers belong to the code at the commit in the evidence file; a change to a recipe, the
  mapper or a theme re-runs them in `pnpm -r test`.
