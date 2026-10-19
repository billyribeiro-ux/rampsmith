# ADR-247: The integrated corpus runner and its gates

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/corpus-tools`, `src/runner/`)

## Context

ADR-203 defined the runner contract and the scoring functions (`src/contract/metrics.ts`), tested
against an oracle. R2's exit criterion (PLAN §5) needs the real thing: the scanner, the mapper
and the patch engine run against the corpus, with tests that fail below the bar.

## Decision

1. **`runCorpus(browser, corpus, options)`** (`src/runner/run.ts`) does, for each failing theme:
   1. **Scan and join.** Every page is rendered with the pinned renderer and checked in Chromium
      at 1280×800 with axe-core 4.14.0 (`checkPage`). Each result node is joined to its golden
      finding by rule, outcome and element, as the browser check (ADR-204) does. Any scanner
      finding without a golden finding, golden finding that did not fire, or count mismatch is a
      `problem`, and the run test fails on it.
   2. **Map.** Each node of a golden finding that needs mapping goes to `Mapper.map` with the
      rendered element (tag, attributes, collapsed text, ancestors, the previous siblings and
      the number of following siblings), the check data axe-core reported (`fgColor`, box size)
      and the store resource the page shows. A finding with several nodes is mapped only if all
      its nodes map to the same span, at the lowest confidence of them; otherwise `needs_review`.
   3. **Plan.** A finding whose expected fix is a theme patch goes to `planFix` (ADR-248) with
      the mapped span if it was mapped at 0.9 or more, and the extra spans the mapper listed as
      `identical`. Parameters the engine cannot know (label text and key, the decorative
      reason) come from the golden finding's `expectedFix.params`, the stand-in for the merchant
      or the AI proposal. A finding mapped below 0.9 is not patched (`unmapped`). A finding the
      golden marks as an expected refusal is run on its golden span, to prove the refusal code.
   4. **Patch.** All edits of the theme, and the locale edits for every translation key the
      recipes asked for, are applied at once with `buildPatch`; identical edits are merged.
   5. **Theme Check.** `validateNoNewOffenses(before, after)` on the patched theme; each new
      offense counts as a regression.
   6. **Re-render and rescan** every page of the patched theme. For each golden occurrence the
      runner counts the nodes still firing, and per `<rule>:<outcome>` the golden nodes that
      fired before and no longer do (`resolved`); a finding is `stillFiring` if any of its nodes
      is.
   7. **Records and scores.** Mapping records, fix records, page scans before and after, and the
      Theme Check counts feed `scoreMapping`, `scoreFixes` and `findRegressions`, then
      `buildReport`.
2. **The gates are tests** (`test/runner.test.ts`), run by `pnpm -r test` in CI. They fail
   unless: no unjoined scanner finding; mapping accuracy at least 0.95 with none wrong at 0.9 or
   more; targeted fixes at least 0.90 overall and in each theme-patched top-six category;
   `unexpected` empty (every expected refusal refuses with its golden code); no regression
   (a page that fails to render, a new axe result, a vanished result) and no new Theme Check
   offense; the records and the report validate against `corpus/schema/runner-*.schema.json`.
   A second run without the contrast recipe, on golden spans, must land below the fix-rate bar,
   which proves the gate can fail (WS-11's measurement: 30 of 35).
3. **Regressions are ADR-203's, unchanged**: axe-core's view is the measure (CONTRACT.md,
   "Render regressions"). A purely visual change no rule sees is not detected; the runner does
   not claim otherwise.
4. **Output.** `src/cli.ts run [<theme>...] [--golden-spans] [--out <file>]` writes the JSON
   report (`jsonReport`: gates, scores with a verdict per finding, a table per category with
   mapping accuracy and fix rate, per theme counts, each finding's mapping and fix detail, the
   patch diffs) and, beside it, the records (`runnerRecords`, schema-valid), and exits 1 below a
   gate. The default path is `packages/corpus-tools/test-results/corpus-report.json`
   (git-ignored). The gate test writes the same report there on every run; CI does not upload
   it today (an integration note suggests keeping it as a build artifact).
5. **`options.spans: 'golden'`** applies the fixes at the golden spans instead of the mapped
   ones, and `options.withoutRecipes` treats rules as having no recipe. They exist to measure
   the recipes without the mapper and the engine as WS-11 left it (ADR-249); the default run
   uses neither.

## Consequences

- The mapper cannot score by luck: it is given the rendered element, never the golden span, and
  the gate test compares its span with the golden one.
- The golden `expectedFix.params` stands in for the merchant's choices. If the API supplies
  different text, the fix is the same recipe with other parameters; the runner proves the
  recipes and the mapping, not the AI proposal.
- `BUILT_RECIPES` and `REFUSAL_CODES` in `src/golden.ts` still duplicate lists that
  `@rampsmith/liquid-patch` owns. WS-11's `contract.test.ts` asserts the engine as it was
  (without `contrast`), so they were left unchanged; the integrator can replace them with
  imports and update that test (evidence file, integration notes).

## Rejected alternatives

- Giving the mapper the golden span's file to narrow its search: it would measure the oracle.
- Applying each fix on its own and rescanning after each: interactions between patches (two
  edits to one file, a shared snippet) are what the real engine meets; all edits go in one
  patch, as the contract says.
- A pixel or DOM diff as the regression measure: ADR-203 chose axe-core's view; a stronger check
  can be added without changing the contract.
