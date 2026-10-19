# ADR-241: No Dawn or other third-party theme files; hand-written fixtures cover every recipe

- Status: Accepted (supersedes ADR-105)
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`)

## Context

ADR-105 vendored ten Dawn 16.0.0 files under `packages/liquid-patch/test/fixtures/dawn/` after
reading Dawn's `LICENSE.md`: MIT with one added condition, that the rights "may only be exercised
to develop themes that integrate or interoperate with Shopify software or services" and that "all
other uses of the Software are strictly prohibited". The architect ruled on 17 Oct 2026 (STATUS.md,
"Architect rulings on the stream findings") that Dawn files stay out of this repository, which is
public, and put the question on the attorney's list (LAUNCH.md C, row 13). ADR-105 itself said
that the hand-written fixtures "still exercise every recipe, so no gate depends on Dawn".

## Decision

1. Delete `test/fixtures/dawn/` (the ten files, `LICENSE.md` and `SOURCE.json`), `test/dawn.ts`,
   `test/fixtures.test.ts` (the byte-identity check of the vendored blobs) and
   `test/dawn-recipes.test.ts`. No file in this repository comes from Dawn or any other
   third-party theme; the vendored copies stay in the git history of `ws/liquid-patch` only,
   which is not merged (STATUS.md, integration hold).
2. Add a hand-written fixture theme, `test/fixtures/lantern/`, written from scratch for
   Rampsmith: a layout, four snippets, one section and three storefront locale files (English,
   German, Japanese) that use the patterns the six recipes fix or recognise (lang on `<html>`,
   skip link, visually hidden text inside icon links and buttons, `aria-label` from a translation
   key, a label by `for` and by wrapping, image `alt` printed from the image object, an `alt`
   inside `{% if %}`). `test/lantern-recipes.test.ts` replaces the Dawn test one for one: every
   recipe reports `already-fixed` on the pristine theme; with the fix removed by a span edit it
   puts the fix back (byte for byte where the theme wrote the fix the way the recipe does), the
   patch passes Theme Check with no new offense, and a second run is a no-op.
   `test/theme-check.test.ts` and `test/translations.test.ts` use the same theme.
3. Rename `DAWN_VISUALLY_HIDDEN_CLASS` to `DEFAULT_VISUALLY_HIDDEN_CLASS` (value unchanged,
   `visually-hidden`, a name many themes use) and remove the Dawn wording from comments.
4. The synthetic corpus (`corpus/`, ADR-201) is the recipes' theme-level proof; the corpus
   runner (ADR-247) applies every recipe to three themes in three markup traditions and keeps a
   unified diff per theme as the golden before-and-after pair (PLAN §23).
5. Theme Check input is limited to `.liquid` and `.json` files. `toSourceCode` in
   `@shopify/theme-check-common` 3.30.1 parses every other extension as JSON, so the first
   fixture with a CSS asset produced 21 false `JSONSyntaxError` offenses; Theme Check's own
   command line reads only Liquid and JSON files. `themeOffenses` now drops other files from
   the checked set and keeps them in the in-memory file system, so checks that look for an
   asset still find it. Without this, a patched CSS asset could move the "new offense" count
   (ADR-242 patches CSS).

## Consequences

- No licence question attaches to the test fixtures of `liquid-patch` any more; ADR-105's
  "founder or attorney confirmation" no longer blocks anything. ADR-105 stays as the record of
  why vendoring was considered; its index row should read "Superseded by ADR-241" at
  integration (integration note in `docs/evidence/ws-14-patch-r2.md`).
- The recipes lose proof on one real theme's markup. The corpus's `birch` theme (older Liquid
  conventions: `{% include %}`, `img_url`, single-quoted attributes, CRLF) and `cedar` (theme
  blocks) take that role, and the property tests (`recipe-properties.test.ts`) generate markup
  variants.
- Theme Check results for themes with non-Liquid assets are now comparable before and after a
  patch.

## Rejected alternatives

- Keeping the Dawn files until the attorney answers: the architect ruled them out of the
  repository now.
- Fetching Dawn at test time: needs network in tests and the same licence reading.
- Copying Dawn's markup into the fixtures by hand: the same rights question; every fixture here
  was written for Rampsmith.
