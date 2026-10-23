# ADR-295: Core recipes for every plan with the channel, every recipe on the higher plan

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-290 (the flag), PLAN §20 (billing features `core_recipes`, `every_recipe`, `github_pull_requests`)

## Context

`@rampsmith/liquid-patch` has recipes of different risk. Most add a missing attribute or element
(a label, a link name, an `alt`, a `lang`). The colour-contrast recipe changes a design decision
and needs measurements the scanner took in a browser. PLAN §20 gives the plans different feature
sets for these.

## Decision

1. `POST /v1/shopify/code-fixes/batches` needs `github_pull_requests` and a connected repository.
   The recipes a batch may use are fixed when the batch is created: `every` if the plan allows
   `every_recipe`, otherwise `core` (the `core_recipes` set). The choice is stored on the batch row,
   so a later plan change does not alter a batch already planned.
2. The engine passes `contrast: batch.recipes === 'every'` to `planBatch`. A `core` batch never
   plans a contrast change, and reports those findings as skipped with a code, not as failures.
3. A finding that needs a person's words (an accessible name, the reason an image is decorative)
   is planned only when the batch carries a judgement for it: at most 50, a key matching the
   catalogue key pattern, text of at most 200 characters. Without one the finding is skipped with
   `invalid-parameter`; the recipe never invents wording.

## Consequences

The client cannot ask for more than its plan allows, and the server decides. The outcome document
lists every skipped finding by code, which the Code fixes screen shows.
