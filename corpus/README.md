# Theme test corpus

Synthetic Shopify themes with golden findings (PLAN §23). Every theme here was written by hand
for Rampsmith: no Dawn or other Shopify theme file is in this directory (architect ruling on
the Dawn licence, 17 Oct 2026). The corpus is what the source mapper and the patch engine are
measured against for R2: at least 95% of findings mapped to the right span at confidence 0.9 or
above with no wrong span above it, and at least 90% of targeted findings fixed with zero render
regressions. How that is computed: [CONTRACT.md](CONTRACT.md).

## Layout

| Path | What it holds |
| --- | --- |
| `manifest.json` | Stores, themes, the pages rendered for each theme, and the pinned renderer and checker |
| `themes/<name>/` | One Online Store 2.0 theme: `layout/`, `templates/` (JSON), `sections/`, `blocks/`, `snippets/`, `locales/`, `config/`, `assets/` |
| `golden/<name>.json` | The theme's golden findings, or a store's data-audit findings |
| `fixtures/store.json`, `fixtures/store-clean.json` | The Harbor & Pine fixture store, with and without its data-audit failures |
| `schema/` | JSON Schemas: golden files, the manifest, the runner's records and report |
| `.gitattributes` | Keeps birch's snippets in CRLF so their offsets hold in every checkout |

## Themes

| Theme | Kind | Pages | Golden findings | Targeted | What it exercises |
| --- | --- | --- | --- | --- | --- |
| aurora | failing | 8 | 19 | 17 | Current conventions: JSON templates for the eight R1 page types, section groups, colour settings, icon snippets, `image_tag` in links |
| birch | failing | 5 | 16 | 13 | Older themes: tabs, CRLF, static sections, `{% include %}`, `img_url`, a `.css.liquid` stylesheet, icon fonts, unquoted and single-quoted attributes, duplicated mobile markup |
| cedar | failing | 4 | 13 | 5 | Theme blocks, section `{% stylesheet %}`, `inline_asset_content`, srcset, a password layout, custom widgets with broken ARIA, small targets, an iframe |
| aurora-clean, birch-clean, cedar-clean | control | 17 | 0 | 0 | Each failing theme with every finding fixed; must produce zero results |

The store `harbor` adds 5 data-audit findings (product media alt text, rich text), which the
data audit reports from the Admin API and the data fixes repair. In total: 53 golden findings,
35 of them targeted by the patch engine.

## Running the checks

```sh
pnpm --filter @rampsmith/corpus-tools test       # schemas, rules, spans, rendering, axe in Chromium
pnpm --filter @rampsmith/corpus-tools run corpus render aurora /tmp/aurora  # write the pages
pnpm --filter @rampsmith/corpus-tools run corpus scan cedar                 # print axe results
pnpm --filter @rampsmith/corpus-tools run corpus spans --write              # re-find offsets
```

Where Playwright's browser download is blocked (docs/ENVIRONMENT.md), set
`CHROMIUM_EXECUTABLE_PATH` and `CHROMIUM_ARGS` to the `@sparticuz/chromium` build; CI installs
the headless shell that the locked playwright-core bundles.
