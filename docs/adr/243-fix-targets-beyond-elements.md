# ADR-243: Fix targets beyond elements: colour values, CSS declarations and store data

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`)

## Context

PLAN §12 describes a recipe target as an element: `{file, start}` of a start tag. ADR-205
(findings 3 and 8) showed that 9 of the corpus's 48 rendered findings are fixed somewhere else:
a colour setting in a JSON file (3), a CSS declaration (5) or a field of store data (1). The
contrast recipe (ADR-242) acts on the first two; the mapper (ADR-244 to ADR-246) must name all
three. This ADR fixes the shapes and records what shopify.dev says about each, read on
19 October 2026.

## Decision

1. **Four span kinds**, the same as the corpus contract (corpus/CONTRACT.md, "Span equality"),
   all in UTF-16 code units of the file's text as stored:
   - `element`: `{file, start, tag}`, the offset of the `<` of a start tag in a `.liquid` file;
   - `json-value`: `{file, pointer, start, end}`, an RFC 6901 pointer and the value's text,
     string quotes included;
   - `css-declaration`: `{file, property, start, end}`, from the first character of the
     property name to the end of the value, `!important` included, without the `;`;
   - `data`: `{resource, field, start, end}`, a Shopify global id, an Admin API field name, and
     the offsets of the element's start tag in that field's HTML.
     The first three are theme source; a `data` span is never written through a theme patch
     (the Admin API edits it, behind the merchant's approval, PLAN §12).
2. **`ColorSpan`** (`src/recipes/contrast.ts`) is the recipe-side type for a colour:
   `json-value` or `css-declaration`. For JSON the recipe re-finds the value from the pointer
   (`jsonc-parser`, comments kept) and, when offsets are given, requires them to be the
   value's; for CSS the offsets are required and must hold a declaration of that property. It
   returns `target-not-found` when the file moved.
   `MappedSpan` (`src/map/types.ts`) is the union the mapper returns; a `MappedJsonValue` always
   has offsets, so a caller can hand it to `planFix` (ADR-248) unchanged.
3. **JSON settings.** `config/settings_data.json` has a required `current` object holding "all
   of the setting values that are currently saved in the theme editor" and a required `presets`
   object, one entry per preset in the same format as `current` (shopify.dev, "settings_data.json",
   https://shopify.dev/docs/storefronts/themes/architecture/config/settings-data-json). Older
   themes stored a preset name as the string `current`; the mapper reads both
   (`/current/<id>` or `/presets/<name>/<id>`), because the theme editor has written both. A
   `color` setting is stored as a hex string (the docs' examples are `#FFFFFF`; an unset
   colour is distinct from transparent `#00000000`) and prints as a colour object; a
   `color_background` setting is a CSS background string, possibly a gradient
   (https://shopify.dev/docs/storefronts/themes/architecture/settings/input-settings). The
   contrast recipe refuses what is not one opaque colour (`unsupported-color`, ADR-242).
   Section settings live at `<pointer>/settings/<id>` of the JSON template or section group.
4. **CSS sources.** The mapper reads the CSS a page loads from `assets/*.css`, `<style>` and
   `{% style %}` tags, and `{% stylesheet %}` tags. shopify.dev: stylesheet tags in sections,
   blocks and snippets "are collected into one `styles.css` file, which is linked through
   `content_for_header`", each file may have one, and "Liquid isn't rendered inside the tag"
   (https://shopify.dev/docs/storefronts/themes/best-practices/javascript-and-stylesheet-tags;
   https://shopify.dev/docs/api/liquid/tags/stylesheet). The CSS index therefore puts every
   `{% stylesheet %}` of the page at `{{ content_for_header }}` in load order (ADR-245).
   Liquid inside any CSS region is replaced by filler of the same length before postcss reads
   it, so offsets stay offsets of the original file.
5. **`.css.liquid` is read but flagged.** Shopify deprecated processing `.css.liquid` and
   `.js.liquid` files on 28 August 2025 ("no longer processed or served correctly as CSS in the
   theme"; https://community.shopify.dev/t/shopify-is-deprecating-the-processing-rendering-of-css-liquid-and-js-liquid-files/21957).
   The corpus's birch theme keeps one such asset on purpose (a legacy theme), so the index
   reads it and a declaration there maps like any other. A live store served by such a file
   may not honour the edit: the product must say so when the span's file ends in `.css.liquid`
   (integration note in `docs/evidence/ws-14-patch-r2.md`).
6. **Layout.** A JSON template's `layout` key is "the filename of the layout to use when
   rendering the template", default `theme.liquid`; `false` renders it without a layout
   (https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates).
   `layoutFor` returns `layout/<name>.liquid` (a trailing `.liquid` in the key is tolerated) or
   `null`; page-wide rules on a template with no layout are `unmapped`.
7. **A new dependency**, `postcss-selector-parser` 7.1.6, in `packages/liquid-patch`, for
   selector matching (ADR-245). Registry check, 19 October 2026 (`npm view`): 7.1.6 is the
   latest release (3 September 2026), with two dependencies (`cssesc`, `util-deprecate`) and no
   peer dependencies; it is the parser postcss's own tools use. The pnpm lockfile changed only
   through pnpm.

## Consequences

- One mapper output type serves the engine, the API and the corpus runner; a data span is
  recognisable and never reaches `buildPatch`.
- A theme whose colour lives in a gradient, a `var()` with only a fallback, or `rgba()` with
  alpha is refused with a typed code, not guessed at.
- `.css.liquid` support is a compatibility feature with a known limit on live stores.

## Rejected alternatives

- Reducing every target to an element and finding the colour from its computed style: ADR-205
  finding 8 showed this maps to the wrong span, and the fix is not in the element.
- Reading `config/settings_schema.json` to know which settings are colours: the schema says what
  a setting is meant to be, the cascade says which value reached the text; the schema is
  consulted by the data audit, not here.
