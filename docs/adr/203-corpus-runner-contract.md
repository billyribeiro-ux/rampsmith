# ADR-203: The corpus runner contract: mapping accuracy, fix rate and render regressions

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-11 (`corpus/CONTRACT.md`, `packages/corpus-tools/src/contract/`)

## Context

PLAN §23 sets the mapping target ("at least 95% of corpus findings mapped to the right span at
confidence 0.9 or above, with zero wrong spans above that threshold") and PLAN §5 the R2 fix
target ("fixes at least 90% of targeted findings on the theme test corpus with zero render
regressions"). Neither says which findings count, what "right span" means for a finding that is
not an element, what "targeted" means, or what a render regression is. The mapper and the
integrated patch pipeline are built by other streams; the corpus must define the measurement so
their results can be scored without argument.

## Decision

The full contract is `corpus/CONTRACT.md`; the scoring is pure code with tests written first
(`src/contract/metrics.ts`, `test/metrics.test.ts`); records and report have JSON Schemas
(`corpus/schema/runner-records.schema.json`, `runner-report.schema.json`). In short:

1. **Mapping denominator**: every rendered golden finding (`mapping` not `none`). Data-audit
   findings carry their resource and field and need no mapping (PLAN §11).
2. **Right span**: equal kind and location (element: file, start, tag; JSON value: file,
   pointer, offsets; CSS declaration: file, offsets, property; data: resource, field, offsets).
3. **Correct** is mapped at confidence ≥ 0.9 to the golden span; **wrong above threshold** is
   mapped at ≥ 0.9 to another span; anything below 0.9, `needs_review`, `unmapped` or missing is
   not mapped. Gate: accuracy ≥ 0.95 and zero wrong above threshold.
4. **Targeted**: a deterministic theme patch in the six top categories (low contrast, theme image
   alt text, form labels, empty links, empty buttons, document language) expected to fix the
   finding, with deterministic mapping. Product-media alt text is fixed through the Admin API,
   not the patch engine, so it is not targeted; neither are findings beyond the six (focus,
   target size, skip link, widgets) nor ambiguous mappings.
5. **Fixed**: the engine returned edits and, after all of the theme's patches are applied, no
   occurrence of the finding still fires its rule. Fix rate = fixed / targeted.
6. **Render regression**: a page that stops rendering or is not scanned after patching; on any
   page, a `(rule, outcome)` node count after patching that differs from the count before minus
   the golden nodes the patch resolved (higher means a new result, even one that replaced a
   resolved node; lower means something vanished, such as content swallowed by broken markup);
   or a new Theme Check offense. Two scans of one page, or a page scanned only after patching,
   are errors. Gate: fix rate ≥ 0.90 and zero regressions.
7. **Expected refusals** (liquid-patch's typed refusals, such as `dynamic-content` for a link whose
   name comes from Liquid output) are checked too: a different outcome is reported for review,
   because it means either the golden file or the engine is wrong.

## Consequences

- Scoring cannot be gamed by a confident wrong answer: one wrong span at 0.9 fails the gate.
- Exact accounting per rule and outcome (before, minus resolved golden nodes, equals after) catches
  a patch that adds a failure, swaps one failure for another, or breaks markup so that checked
  content disappears, without pixel comparisons that font differences between machines would make
  flaky. It does not see a visual change that axe-core does not measure.
- With only the six recipes liquid-patch ships at `551b200`, 30 of 35 targeted findings (85.7%)
  can be fixed: the oracle in `test/contract.test.ts` shows the ceiling, and running those recipes
  on the corpus (evidence file) fixed exactly those 30 with zero regressions. The five low-contrast
  findings need the contrast recipe of PLAN §12 before R2 can pass (ADR-205).

## Plan correction

PLAN §5, R2 exit criteria cell: after "patch engine fixes at least 90% of targeted findings on
the theme test corpus with zero render regressions" add "(targeted findings, fixes and
regressions as corpus/CONTRACT.md defines them; ADR-203)".

## Rejected alternatives

- Screenshot comparison as the regression test: deterministic only on one machine image, and a
  contrast fix changes pixels on purpose.
- Counting a wrong span below 0.9 as wrong: below the threshold the finding goes to the AI
  tie-break or review, which is the designed path, so it is "not mapped", not "wrong".
- Scoring per occurrence instead of per finding: PLAN §11 merges occurrences by fingerprint into
  one finding, and a fix is one edit for all of them.
