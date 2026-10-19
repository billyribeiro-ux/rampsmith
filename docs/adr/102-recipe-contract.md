# ADR-102: Recipe contract and the rules of the six markup recipes

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-1 (`packages/liquid-patch`)

## Context

PLAN §12 lists deterministic fixes for missing document language, no skip link, empty links,
empty buttons, missing form labels and hard-coded theme images, and requires that "every
recipe first checks whether its fix is already present, so re-running a recipe is a no-op".
The source mapper (another stream) will hand a recipe a file and the element it found. A
recipe works on source, while the finding came from the rendered page, so the recipe must
decide from markup alone when a fix is safe, present, or not its call.

## Decision

**Contract.** `recipe.run(file, target, params)` takes a parsed file (`{path, source, ast}`),
a target `{file, start}` where `start` is the UTF-16 offset of the `<` that opens the element's
start tag (ADR-101's unit), and typed parameters. It returns one of:

- `{kind: 'edits', edits, translations, notes}`: span edits for this file, the translation
  keys the edits print (for `localeEdits`, ADR-103), and facts for the fix record;
- `{kind: 'already-fixed', reason}`;
- `{kind: 'refusal', code, detail}` with `code` one of `wrong-file`, `target-not-found`,
  `wrong-element`, `liquid-in-attribute`, `conditional-attribute`, `dynamic-content`,
  `main-landmark-not-found`, `head-not-found`, `id-conflict`, `needs-unique-id`,
  `not-labelable`, `no-image-object`, `invalid-parameter`.

Recipes are pure and never write files. Their edits go through `applyEdits` (re-parse) and
`validateNoNewOffenses` (Theme Check, ADR-104) before anything ships. Running a recipe on its
own output returns `already-fixed`: proven for every recipe by fast-check over generated markup
(attribute order and quoting, Liquid in attributes, `{% if %}` attributes, inline and
multi-line layouts, LF and CRLF, tabs and spaces) and on Dawn (`test/recipe-properties.test.ts`,
`test/dawn-recipes.test.ts`).

**Edits match the file's style.** A new attribute goes after the last attribute, separated the
way that attribute is (a newline and its indentation when attributes are one per line). New
children copy the indentation of the element's content and the file's line ending; one-line
markup stays on one line. On Dawn, removing a fix and running the recipe restores the original
file byte for byte for `lang`, the social link text and the search reset button.

**Shared rules.**

- An attribute the recipe would write that already holds Liquid output is refused
  (`liquid-in-attribute`), except output that is plainly the fix: a translation
  (`{{ 'key' | t ... }}`), `{{ request.locale.iso_code }}` for `lang`, or `{{ x.alt ... }}`
  for `alt`. An attribute set inside a Liquid tag in the start tag is refused
  (`conditional-attribute`): which branch renders is a runtime fact.
- Labels use a translation key and English text supplied by the caller (ADR-103); the
  visually hidden class defaults to Dawn's `visually-hidden` and is a parameter.
- Attributes printed wholesale by Liquid (`{{ block.shopify_attributes }}`) are invisible to
  the recipe and ignored.

**Per recipe.**

1. `document-language` (3.1.1), `<html>` in `layout/*.liquid`: adds
   `lang="{{ request.locale.iso_code }}"` (`request.locale` is a `shop_locale`; `iso_code` is
   its IETF tag, per shopify.dev); replaces an empty `lang`; any non-empty static `lang` is
   already fixed. All layouts are accepted, not only `theme.liquid`: `layout/password.liquid`
   renders a full page too.
2. `skip-link` (2.4.1), `<body>` in `layout/*.liquid`: finds `<main>` or `role="main"`, uses its
   static id or gives it one (default `MainContent`, Dawn's), inserts
   `<a class="rampsmith-skip-link" href="#id">{{ 'accessibility.skip_to_text' | t }}</a>` as the
   first child of `<body>`, and a `<style>` block at the end of `<head>` that clips the link
   until it has focus, then shows it black on white (21:1) with the browser's focus outline.
   The CSS travels with the link so the fix does not depend on theme CSS. Already fixed when
   an `<a href="#id">` precedes the main landmark.
3. `empty-link` (2.4.4, 4.1.2) and `empty-button` (4.1.2): the element's name sources are read
   from source. Named (already fixed): non-empty static `aria-label`, `aria-labelledby` or
   `title`; a translation in `aria-label`; text content; a translation in content; an `<img>`
   with non-empty alt; an `<svg>` with `aria-label` or a `<title>`. Silent (no name): SVG,
   `{{ ... | inline_asset_content }}`, `.svg` strings, `{% render 'icon...' %}`, comments,
   `assign`/`capture`, `aria-hidden="true"` subtrees, images without alt. Anything else in
   content that may print text (other output, other `render`, text inside `if`/`for`) is
   refused as `dynamic-content`, because a static label could give the element two names.
   Links get `<span class="visually-hidden">{{ 'key' | t }}</span>` as their last child;
   buttons get `aria-label="{{ 'key' | t }}"` (an empty `aria-label=""` is replaced).
4. `form-label` (1.3.1, 4.1.2), `<input>`, `<select>`, `<textarea>`: refuses input types that
   take no label (`hidden`, `submit`, `reset`, `button`, `image`). Already fixed by a
   `<label for>` anywhere in the file whose `for` equals the control's id as written (static
   or Liquid, before or after the control, as in Dawn's search), a wrapping `<label>`, or the
   name sources above. Otherwise inserts
   `<label for="id" class="visually-hidden">{{ 'key' | t }}</label>` before the control and
   adds an id only when there is none: the caller's, else `Field-<name>-{{ section.id }}` in
   `sections/`, `Field-<name>-{{ block.id }}` in `blocks/`, `Field-<name>` in `layout/` and
   `templates/`. Snippets can render several times per page and loops repeat, so there a
   caller id is required (with Liquid output inside a loop): `needs-unique-id`.
5. `image-alt` (1.1.1), `<img>`: already fixed by any static `alt` (an empty one means the
   theme declared it decorative), by `alt` printing an `.alt` property, or by
   `role="presentation"`/`"none"` or `aria-hidden="true"`. With `decorative: {reason}` it adds
   `alt=""` and returns the reason as a note for the fix record. Otherwise it reads the image
   object from `src`, `srcset` or `data-src` (`{{ object | image_url ... }}` or `img_url`,
   dropping a trailing `.src`) and adds `alt="{{ object.alt | escape }}"`, as Dawn writes it.
   `image_url` also accepts article, collection, product, variant, line_item and country
   objects (shopify.dev), which have no `alt`; Liquid types are invisible in source, so the
   object must be named like an image or media object (`image`, `media`, `img`, `photo`,
   `picture`, `logo` in its last named segment), else `no-image-object` asks for a decision.

## Consequences

- The mapper only needs a file and the offset of a start tag; recipes reject anything else
  with a typed reason the UI can show.
- Conservative refusals send some real failures to AI proposals or review instead of
  risking a duplicate name, a wrong alt source or a duplicate id.
- Dawn-style themes get fixes that look like Dawn's own markup, which keeps pull requests
  easy to review.

## Rejected alternatives

- Trusting the rendered finding alone and always adding a label: duplicates names when
  Liquid prints text on other pages or states.
- `aria-label` on inputs instead of `<label for>`: PLAN §12 asks for a label, which also
  enlarges the click target when made visible later.
- Taking alt text from the product title for any `image_url` object: misleading text is worse
  than asking.
