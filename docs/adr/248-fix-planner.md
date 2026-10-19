# ADR-248: The fix planner: from a rule and a mapped span to a recipe

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`, `src/plan.ts`)

## Context

The recipes (ADR-102, ADR-242) each take a parsed file, a target and their own parameters. The
mapper (ADR-244 to ADR-246) returns a span. Something has to choose the recipe for a rule, check
that the span is the kind the recipe acts on, and say which parameters come from the engine and
which need judgement. Without it, the API and the corpus runner would each carry the same table.

## Decision

`planFix({rule, span, files, params?, contrast?, candidate?})` returns a `RecipeOutcome` (edits,
`already-fixed`, or a typed refusal) or `null` when the rule has no deterministic recipe.

| Rule (axe-core id) | Recipe | Span kind | Brought by the caller |
| --- | --- | --- | --- |
| `html-has-lang`, `html-lang-valid` | `document-language` | element | nothing |
| `image-alt` | `image-alt` | element | `decorative.reason`, else the recipe refuses |
| `label`, `select-name` | `form-label` | element | `label` (key and text), optional `id`, `visuallyHiddenClass` |
| `link-name` | `empty-link` | element | `label`, optional `visuallyHiddenClass` |
| `button-name` | `empty-button` | element | `label` |
| `bypass` | `skip-link` | element | optional `label` |
| `color-contrast` | `contrast` | json-value or css-declaration | `contrast` evidence from the scan |

1. **What the engine supplies** is mechanical: the span from the mapper; for contrast, the
   background colour (axe-core's `bgColor`) and whether the text is large, from the measured
   font size and weight (`isLargeText`, 18 pt, or 14 pt bold). **What the caller supplies** needs
   judgement: the accessible name of a link, button or field, and the reason an image is
   decorative. These come from the merchant or the AI proposal (PLAN §12), never from the
   planner. A missing parameter is the recipe's typed `invalid-parameter` refusal, not a guess.
2. **Candidates.** For contrast the planner applies `nearest` unless the caller names
   `stronger` (ADR-242); the merchant-facing flow shows both, the planner only applies one.
3. **Span kinds are checked here.** An element rule given a `json-value`, `css-declaration` or
   `data` span refuses with `wrong-element`; contrast given an element or data span refuses
   with `wrong-element`; a span whose file is not in the theme refuses with `wrong-file`; a file
   that does not parse refuses with `wrong-file`. A `data` span therefore never yields edits.
4. **No recipe, no edit.** `target-size`, `link-in-text-block`, `rs-focus-indicator-missing`
   and the widget-role rules have no deterministic recipe; the planner returns `null`, and the
   finding is reported as such (the corpus keeps them untargeted, ADR-203). `hasRecipe(rule)` tells
   the caller before it asks.
5. **Several spans, one finding.** The planner fixes one span. A caller with an `identical` list
   from the mapper (ADR-244 point 6) calls it once per span and merges the edits and
   translation requirements, as the runner does.

## Consequences

- The recipe table lives once, next to the recipes.
- The planner parses the file again for each call. The whole corpus run (three themes, scan,
  plan, patch, rescan) takes about 16 seconds, mostly the browser; a caller that patches many
  findings of one file and cares can use the recipes directly with one parsed file.

## Rejected alternatives

- Letting the mapper choose the recipe: mapping is about where, planning about what; the corpus
  scores them separately.
- Making `label` text up from the element (alt from file names, names from `href`): the plan
  forbids unreviewed generated names (PLAN §12); the caller supplies them.

## Integration

How the engine and API call this, in order: `new Mapper(files).map(finding)`; if `status` is
`mapped` and `confidence >= CONFIDENCE_THRESHOLD`, `planFix({...})` for the span and each
`identical` span; collect `edits` and `translations`; `localeEdits`; `buildPatch`;
`validateNoNewOffenses`; then rescan. `needs_review` goes to the AI tie-break with its
candidates; `unmapped` goes to a person.
