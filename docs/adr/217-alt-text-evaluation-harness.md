# ADR-217: The alt-text evaluation harness, its open image set and its recorded responses

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §5 R1, §13, §23; LAUNCH.md section E)

## Context

PLAN §13 asks for a golden set of 500 product images across 20 categories with two
human-written references each, automatic checks on every candidate (length, banned phrases,
language, unsupported attributes graded by Sonnet 5.5), human rating of a 50-image sample per
release by two raters, a gate (the mean rating does not fall; unsupported attributes under
2%), and the production signal of drafts approved without edits, target 80% (also an R1 exit
criterion). The repository must stay small, every image must be openly licensed, and the
founder's Anthropic key (LAUNCH.md section C, row 5) comes last.

This session could not reach Wikimedia Commons or Openverse (the egress proxy refused both on
2026-10-17), so the images come from openly licensed sample data inside packages on the Python
Package Index, whose licences are stated in those packages, plus images drawn here.

## Decision

1. **Dataset format** (`eval/dataset/manifest.json`, validated by `loadDataset`): per image an
   id, file, category, product title and type, locale, expectations (decorative, mostly text,
   people, an instruction aimed at a model), required attribute groups, absent attributes,
   names that must never appear, two references, and the licence (SPDX id, author, where the
   licence is stated, where the copy came from, modifications). The 500-image golden set uses
   the same format and lives outside the repository.
2. **The bundled set: 20 images in 14 categories, 536 KB**, each resized to a 448 px long edge.
   Thirteen photos: eleven CC0 or public-domain images from the scikit-image 0.25.2 wheel
   (`coffee`, `chelsea`, `astronaut`, `rocket`, `clock_motion`, `camera`, `horse`, `brick`,
   `grass`, `gravel`, `hubble_deep_field`; licences quoted from scikit-image's own data
   documentation) and two CC BY 2.0 photos from the scikit-learn 1.7.2 wheel (`china.jpg` by
   danielbuechele, `flower.jpg` by vultilion). Seven CC0 images drawn by
   `eval/dataset/make_images.py`: a size chart, a tea box with ingredients, a sock pack printed
   with an instruction to the model, a striped T-shirt, a fabric swatch card, a mug and a
   promotional banner. Images whose licence the source package does not state (matplotlib's
   `grace_hopper.jpg`, scikit-image's `coins` and `logo`) were left out.
3. **References** are AI-written by this stream and say so in the manifest; two human raters
   replace them before the human-rated gate counts.
4. **Metrics** (`@rampsmith/ai/eval`): a candidate is "approvable unedited" when the pipeline
   produced a draft that passed every check (ADR-213), covers at least 75% of the required
   attribute groups, mentions no absent attribute, names no one, and, for an image labelled
   decorative, when the model said decorative. The run gate is approvable ≥ 80%, unsupported
   attributes < 2% of described images, and no named person. `approvedUneditedRate` computes
   the production signal per prompt version from review events; `selectRatingSample` draws the
   50 images deterministically; `summarizeRatings` and `releaseGate` apply the human gate.
   Live runs add the Sonnet 5.5 grader (`grade-alt-text@1`) to the label checks.
5. **Recorded mode now, live mode with the key.** The runner drives the production pipeline
   (same prompts, schemas, checks, escalation). Recorded mode answers from
   `eval/recorded/<prompt version>/`, keyed by the SHA-256 of each request without its
   metadata, so a changed prompt, schema, image or model finds no recording and fails instead
   of replaying a stale answer. The 25 bundled recordings are **authored**: written by this
   stream in the documented response shape, marked `authored:` in their provenance, not
   captured from the API. They make the recorded run a substitute test of the pipeline and the
   metrics (90% approvable, 0% unsupported, 25% escalated), not a measurement of the model.
   `pnpm --filter @rampsmith/ai run eval -- --live --record` replaces them with real responses
   once the key exists; then run `pnpm format`.
6. **Live checks** (`test/live.test.ts`) run whenever `ANTHROPIC_API_KEY` is set and otherwise
   skip with a notice naming LAUNCH.md section C, row 5.

## Consequences

- CI proves the harness, the pipeline and the metric arithmetic today; the 80% target and the
  2% gate are measured on the real model in LAUNCH.md section E.
- Twenty images say little about quality on their own; they exist to keep the harness honest
  and cheap to run on every prompt change (under $0.10 per live run with the grader, at
  synchronous prices).
- The authored recordings must never be quoted as model results.

## Plan correction

- PLAN §13 "Evaluation harness", first bullet: "A golden set of 500 product images across 20
  categories, each with two human-written references, kept outside the repository in the
  harness's manifest format; the repository carries a 20-image openly licensed set for CI
  (ADR-217)."
- PLAN §13, add: "Recorded responses keyed by request hash let CI run the harness without the
  API; a live run refreshes them."
- PLAN §23 By component, AI row: "The evaluation gate in section 13; `@rampsmith/ai/eval`."

## Rejected alternatives

- Scraping product photos from stores: not openly licensed.
- Committing 500 images: too large for the repository.
- Calling the model in CI: needs a founder input, and results would vary run to run.
