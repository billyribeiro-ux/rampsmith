# ADR-205: What the corpus found about the fix catalog, the recipes and the scanner

- Status: Accepted (19 October 2026; carried out by ADR-242 to ADR-249 on `ws/patch-r2`)
- Date: 2026-10-18
- Stream: WS-11

## Context

Writing themes that reproduce each PLAN §12 fix-catalog category, and proving every finding with
axe-core 4.14.0 in Chromium, surfaced facts the plan and the sibling streams should take into
account. Each is backed by a corpus finding and the browser check (`test/browser.test.ts`) or
the contract test (`test/contract.test.ts`).

## Findings

1. **No skip link (2.4.1) is not an axe-core failure on pages with a landmark.** axe-core's
   `bypass` passes when the page has a landmark, a heading or an internal link, and reports
   only as incomplete otherwise (`reviewOnFail`). W3C's Understanding 2.4.1
   (https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html, read 2026-10-18) lists ARIA11
   (landmarks) and H69 (headings) as sufficient techniques on their own, beside G1 (skip link). So
   a theme with `<main>` and no skip link produces no axe-core finding, and its landmarks or
   headings can satisfy 2.4.1, which a person confirms; where `bypass` does report
   (cedar's password layout), there is no `<main>`, and liquid-patch's `skip-link` recipe refuses
   with `main-landmark-not-found`. The skip-link recipe is a best-practice addition, not a fix
   for a reported failure. Golden: `cedar/password-bypass`.
2. **The contrast recipe is required for R2.** 5 of the corpus's 35 targeted findings are low
   contrast (global setting, section setting in a JSON template, `.css.liquid` setting,
   hard-coded CSS asset, section `{% stylesheet %}`). `packages/liquid-patch` at `551b200` ships
   no contrast recipe, so the best reachable fix rate with today's recipes is 30/35 = 85.7%,
   below the 90% gate (`test/contract.test.ts`).
3. **Recipe targets beyond elements.** liquid-patch's `RecipeTarget` is `{file, start}` for an
   element's start tag. Contrast, focus-visible and target-size fixes act on a JSON value or a
   CSS declaration; the corpus records those as `json-value` (pointer and offsets) and
   `css-declaration` (rule selector and offsets) spans. The integrated contract should accept
   those kinds, for example a union of target types.
4. **Rendered findings whose source is store data.** An empty link or image without alt inside
   `{{ article.content }}` or `{{ product.description }}` maps to store data, not theme source;
   the corpus golden (`aurora/article-image-alt`) uses a data span in a11y-rules' `DataLocation`
   shape, and the data audit reports the same element (`harbor/article-img-alt-missing`). The
   mapper must route Liquid output of rich-text fields to the resource and field.
5. **axe-core behaviour the scanner inherits** (observed in the corpus with 4.14.0):
   `label` accepts a non-empty placeholder as the accessible name, so placeholder-only search
   fields produce no finding; `label` and `select-name` carry criterion 4.1.2 only, not 1.3.1 as
   PLAN §12's form-label row lists; two small links to the same URL are treated as one target
   by `target-size`; a symbol link text with a different `aria-label` returns
   `label-content-name-mismatch` as incomplete.
6. **Section-group wrapper ids are undocumented.** shopify.dev documents
   `template--<id>__<key>` for JSON-template sections but not the id form of group sections; the
   corpus renders `sections--<n>__<key>` and the mapper should rely on the `__<key>` suffix plus
   the group JSON, not on the prefix (ADR-201).
7. **Duplicated mobile and desktop markup** makes mapping ambiguous: birch's header has two
   identical cart links, one hidden at 1280px; only the parent's class tells them apart
   (`birch/desktop-cart-link-name`). Fixing only the mapped span leaves the hidden copy empty for
   mobile users; the engine should offer the same edit for identical siblings.

8. **The mapper must output more than elements.** 9 of the 48 rendered findings map to a target
   that is not an element: 3 colour settings (two global settings in `config/settings_data.json`
   and one section setting in `templates/index.json`), 5 CSS declarations (in assets and in a
   section `{% stylesheet %}`), and 1 rich-text field. PLAN §12's mapping steps cover elements and
   global colour settings only. A mapper that stops at the element tops out at 39 of 48 (81%),
   below the 95% gate, and mapping a CSS-driven colour to the element at 0.9 or above is a wrong
   span: the fix is not there. Each such golden finding records that element as `rendersFrom`.

## Plan correction

PLAN §12, "Fix catalog, in build order", the "No skip link (2.4.1)" row, Fix cell. Replace
"Skip link to the main landmark, visible on focus" with:

```markdown
Skip link to the main landmark, visible on focus; a best-practice addition where the page has a landmark or headings (axe-core then reports nothing, and landmarks (ARIA11) or headings (H69) can satisfy 2.4.1), and a refusal where axe-core's `bypass` reports, since that page has no main landmark (ADR-205)
```

PLAN §12, "Mapping a rendered element to its source", step 5. Replace "Page-wide failures map straight to `layout/theme.liquid`; colour failures driven by theme settings map to `config/settings_data.json`." with:

```markdown
5. Page-wide failures map straight to the layout file. Colour failures map to where the colour is set: a theme setting's value in `config/settings_data.json`, a section or block setting's value in the JSON template or section group, or the CSS declaration in an asset or a section's `{% stylesheet %}`. Elements printed by rich-text output (`product.description`, `article.content`, `page.content`) map to the resource and field, as data-audit findings do (corpus/CONTRACT.md; ADR-205).
```

PLAN §12, the "Missing form labels (1.3.1, 4.1.2)" row, Failure cell: replace "(1.3.1, 4.1.2)"
with "(4.1.2; axe-core 4.14 tags `label` and `select-name` with 4.1.2 only)".

## Consequences

- R2 depends on a contrast recipe in `packages/liquid-patch`, or on lowering the targeted set,
  which would need the founder (a PLAN §5 exit criterion).
- The skip-link recipe stays useful but outside R2's fix-rate denominator.
