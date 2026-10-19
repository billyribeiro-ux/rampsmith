# ADR-105: Dawn test fixtures and Dawn's license

- Status: Accepted (vendoring); founder or attorney confirmation requested on the field-of-use
  question below
- Date: 2026-10-17
- Stream: WS-1 (`packages/liquid-patch`)

## Context

PLAN §23 asks for one golden before-and-after pair per recipe per theme, using "Shopify's
open-source reference themes, included only after their licenses are checked". The stream
brief described Dawn as MIT. Dawn's license was read at the pinned commit:

- Repository: https://github.com/Shopify/dawn, commit
  `258f00f64365e2018ca4c62778a6bf55a5d3cd18` ("Dawn 16.0.0 (#3946)", 2026-08-10), fetched with
  `git clone --depth 1` on 2026-10-17.
- `LICENSE.md` is the MIT text with one added condition: "The rights granted above may only be
  exercised to develop themes that integrate or interoperate with Shopify software or
  services, and, if applicable, to distribute, offer for sale or otherwise make available any
  such themes via the Shopify Theme Store. All other uses of the Software are strictly
  prohibited." So Dawn is **not plain MIT**: it is MIT-style with a Shopify field-of-use
  condition. The notice must accompany copies.

## Decision

1. Vendor only the files the tests need, unchanged, under
   `packages/liquid-patch/test/fixtures/dawn/`: `layout/theme.liquid`, four snippets, one
   section and three storefront locale files (`en.default.json`, `de.json`, `ja.json`), with
   Dawn's `LICENSE.md` beside them and `SOURCE.json` recording the repository, commit and each
   file's git blob id. A test recomputes every blob id, so the fixtures provably match upstream
   byte for byte, and fails if any other file appears in the directory.
2. Our reading of the condition: Rampsmith uses these files to develop and test patches to
   Shopify themes, whose output is theme code that runs on Shopify stores (pull requests
   against Shopify theme repositories, and theme packages installed in Shopify). That is
   developing themes that interoperate with Shopify services. The files are not distributed
   as a product or outside that purpose; the repository copy is a test fixture.
3. Nothing in Rampsmith calls these files MIT. Dawn's notice stays with them.
4. If the founder or an attorney reads the condition differently, delete
   `test/fixtures/dawn/` and the Dawn-specific tests (`test/dawn.ts` and the tests that import
   it); the hand-written fixtures still exercise every recipe, so no gate depends on Dawn.

## Consequences

- Recipes are proven on real, current Dawn markup (attribute layout, Liquid inside attributes,
  `{% # theme-check-disable %}` comments, labels after inputs), not only on synthetic fixtures.
- The license question is listed under the stream's open risks for the integrator to raise
  with the founder; it is a legal reading, which CLAUDE.md reserves for the founder.

## Rejected alternatives

- Fetching Dawn at test time: needs network in tests, and would not pin the content.
- Synthetic fixtures only: misses real-world markup the recipes must handle.
- Vendoring the whole theme: more third-party code in the repository than the tests use.
