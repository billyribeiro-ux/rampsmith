# ADR-202: Rendering corpus pages statically with liquidjs and a Shopify shim

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-11 (`packages/corpus-tools`)

## Context

To prove that every golden rule id fires, each corpus page must become the HTML a storefront
would serve, without a Shopify store: the corpus is synthetic, the founder's development stores
come last (LAUNCH.md C), and CI has no Shopify credentials. The render must be deterministic and
pinned, so results never drift between runs.

Registry evidence, read with `npm view` on 2026-10-17:

- `liquidjs` 10.30.0 (latest, published 2026-10-01): MIT, one dependency (`commander`), Node ≥16.
  Supports `render` with `with`/`for`, `liquid`, `echo`, keyword filter arguments (passed to
  filters as `[name, value]` pairs), custom tags and filters, an in-memory file system, and
  Liquid truthiness (`jsTruthy: false`: an empty string is truthy). Probed in a scratch script.
- `jsonc-parser` 3.3.1 (MIT, no dependencies; also used by `packages/liquid-patch`).

## Decision

1. **Engine**: liquidjs 10.30.0 with `strictFilters` (a filter the shim does not implement is an
   error, never an empty string), `jsTruthy: false`, `ownPropertyOnly`, `strictVariables: false`
   (Shopify returns nil for unknown variables), UTC dates, and `'now'` fixed at
   2026-10-17T12:00:00Z so copyright years never change.
2. **Shopify behaviour the shim adds** (`src/render/renderer.ts`):
   - JSON templates (`sections`, `order`, `disabled`, `layout`, `wrapper`), section groups, static
     `{% section %}` with settings from `config/settings_data.json`, and the section wrapper
     `<{tag} id="shopify-section-{id}" class="shopify-section {class}">` from the schema (ADR-201);
   - settings resolved against the schema's defaults and types: `image_picker`
     (`shopify://shop_images/<file>` → fixture image), `collection`, `product`, `link_list`;
     a setting the schema does not define is an error, as the theme editor would reject it;
   - section blocks and theme blocks (`blocks/*.liquid`, nested blocks, `{% content_for 'blocks' %}`
     and `{% content_for 'block', type:, id: %}`); a schema entry with only a `type` refers to a
     theme block; `block.shopify_attributes` renders empty, as outside the editor;
   - tags: `schema` (nothing), `stylesheet` (collected from every section, block and snippet and
     placed where `content_for_header` prints), `javascript` (nothing: the check is static and runs
     no theme script), `style` (`<style data-shopify>`), `form` (Shopify's hidden fields, the
     `form` object, extra attributes), `paginate` (first page of the collection and the `paginate`
     object);
   - filters: `t` (default locale file, `count` plurals, interpolation, escaping unless the key
     ends in `_html`, and `translation missing: <locale>.<key>` for an absent key), `asset_url`,
     `stylesheet_tag`, `inline_asset_content`, `image_url`, `img_url`, `image_tag` (alt from the
     image unless given), `money`, `money_with_currency`, `money_without_currency`, `handle`,
     `handleize`, `link_to`, `date`;
   - page objects: `shop`, `settings`, `routes`, `linklists`, `collections`, `pages`, `blogs`,
     `cart`, `request` (locale, page type, path), `template` (name, suffix, directory),
     `page_title`, and the page's product, collection, page, blog and article or search.
3. **Assets**: `assets/*.css` are served as they are; `assets/*.css.liquid` are rendered with the
   theme settings and served at the name without `.liquid`, as storefronts do. Every image URL
   answers with a generated one-pixel PNG, so no binary fixture is committed.
4. **Scope**: the renderer serves the corpus checks. It is not Shopify's renderer and is never
   used to render a merchant's theme; differences from Shopify are bugs to fix here only when a
   corpus theme needs the behaviour.

## Consequences

- Pages render in milliseconds with no network and no credentials, in CI and locally.
- A corpus theme can only use what the shim implements; an unknown filter or tag fails loudly.
- Shopify-specific output that axe-core does not see (scripts from `content_for_header`, the
  editor's block attributes) is absent by design.

## Rejected alternatives

- Shopify CLI's local preview (`shopify theme dev`): needs a store and a login.
- Rendering through a development store: the founder's stores come last, and results would
  depend on Shopify's live renderer and network.
- A hand-written Liquid interpreter: liquidjs is maintained, MIT, small, and already supports
  custom tags and keyword arguments.
