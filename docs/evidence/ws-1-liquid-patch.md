# WS-1 span patch engine (`packages/liquid-patch`): evidence

Stream WS-1, branch `ws/liquid-patch` from `r0-foundations` at `e43f546`. Every command below
was run in this stream's worktree on 2026-10-17 with Node 26.12.0 and pnpm 12.14.0.

## Dependencies, read from the live registry

Read with `npm view <pkg>@<version> version license peerDependencies engines` and
`npm view <pkg> time --json` on 2026-10-17. Added with
`pnpm --filter @rampsmith/liquid-patch add <pkg>@<exact>` (`-D` for test-only packages).

| Package | Version | License | Peers / engines | Released | Use |
| --- | --- | --- | --- | --- | --- |
| `@shopify/liquid-html-parser` | 2.10.2 (latest) | MIT | none; one dependency, `line-column` ^1.0.2 (MIT) | 2026-09-30 | Parse Liquid and HTML with offsets (ADR-101) |
| `@shopify/theme-check-common` | 3.30.1 (latest) | MIT | none; dependencies MIT/ISC (`lodash`, `postcss`, `minimatch`, `vscode-uri`, `cross-fetch`, `line-column`, `jsonc-parser`, `postcss-safe-parser`, `postcss-selector-parser`, `vscode-json-languageservice`); pins `@shopify/liquid-html-parser` 2.10.2, the same version | 2026-10-01 | Theme Check in memory (ADR-104) |
| `diff` | 9.0.0 (latest) | BSD-3-Clause | engines node >=0.3.1; no dependencies | 2026-04-13 | Unified diffs (ADR-101) |
| `jsonc-parser` | 3.3.1 (latest) | MIT | none; no dependencies | 2024-06-24 | JSON offsets for locale edits and JSON validation (ADR-101, ADR-103) |
| `fast-check` (dev) | 4.10.2 (latest) | MIT | engines node >=12.17.0; dependency `pure-rand` ^8.0.0 (MIT, 8.4.2) | 2026-09-19 | Property tests |
| `vitest` (dev) | 5.0.5 (latest; same pin as `packages/queue`) | MIT | `@types/node` ^22.0.0 \|\| >=24.0.0 (root has 26.6.5); engines node ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0 | 2026-10-15 | Test runner |
| `@vitest/coverage-v8` (dev) | 5.0.5 (latest) | MIT | `vitest` 5.0.5 (exact match); `@vitest/browser` 5.0.5, optional (`peerDependenciesMeta`); dependencies all MIT | 2026-10-15 | Enforces PLAN §23's 95% line coverage in `pnpm test` |

BSD-3-Clause is on the project's license allowlist (`deny.toml`). pnpm 12 fails an install on
any dependency build script left undecided; `pnpm install` succeeds without new `allowBuilds`
entries, so none of these packages runs an install script.

## Parser offsets (ADR-101)

`@shopify/liquid-html-parser@2.10.2` `dist/types.d.ts`:

```ts
export interface Position {
    /** 0-indexed offset in the string, included */
    start: number;
    /** 0-indexed offset, excluded */
    end: number;
}
```

`dist/document/tokenizer.js` reads `source[i]` while `i < source.length`, so offsets are UTF-16
code units. `test/parse.test.ts` proves it: after an emoji the next element starts at index 5.

## Theme Check packages evaluated (ADR-104)

```text
$ npm view @shopify/theme-check-node@3.30.1 version license dependencies
version = '3.30.1'  license = 'MIT'
dependencies = { glob: '^8.0.3', yaml: '^2.8.3', 'vscode-uri': '^3.0.7', '@shopify/theme-graph': '^0.3.5',
  '@shopify/liquid-html-parser': '2.10.2', '@shopify/theme-check-common': '3.30.1',
  '@shopify/theme-check-docs-updater': '3.30.1' }
$ npm view @shopify/theme-check-docs-updater@3.30.1 license dependencies
license = 'MIT'  dependencies = { 'env-paths': '^2.2.1', 'node-fetch': '^2.6.11', '@shopify/theme-check-common': '^3.30.1' }
```

- `theme-check-docs-updater` `dist/themeLiquidDocsDownloader.js`:
  `ThemeLiquidDocsRoot = 'https://raw.githubusercontent.com/Shopify/theme-liquid-docs/main'`
  (network), with bundled fallbacks in `data/`.
- `theme-check-common` `dist/utils/file-utils.js` is the only module importing `cross-fetch`;
  only `checks/asset-size-css` and `checks/asset-size-javascript` use it.
- Scratch run on Node 26.12.0 (`check(theme, config, { fs: memoryFs })` over the vendored Dawn
  files): `ms 136 checks 84`, offenses only `MissingAsset` / `MissingTemplate` for files not
  vendored. `OFFLINE_CHECKS.length` is 85, equal to `recommended.length`.

## Shopify documentation read for the recipes (2026-10-17)

| Page | Fact used |
| --- | --- |
| https://shopify.dev/docs/storefronts/themes/architecture/locales | Storefront `.json` vs schema `.schema.json` locale files; one `*.default.json`; merchants edit storefront translations in the Language Editor |
| https://shopify.dev/docs/storefronts/themes/architecture/locales/storefront-locale-files | `locales/<IETF tag>.json`; nested keys; `t` filter with single-quoted keys; "Translated content is escaped by default", `_html` suffix disables it; regional locales inherit from the base language; 3,400 translations per file; no documented fallback for keys missing from a non-default locale |
| https://shopify.dev/docs/api/liquid/objects/request#request-locale | `request.locale`: "The locale of the request", type `shop_locale` |
| https://shopify.dev/docs/api/liquid/objects/shop_locale#shop_locale-iso_code | `iso_code`: "The ISO code of the locale in IETF language tag format" |
| https://shopify.dev/docs/api/liquid/objects/image#image-alt | `alt`: "The alt text of the image" |
| https://shopify.dev/docs/api/liquid/filters/image_url | Accepts article, collection, image, line_item, product, variant and country objects and their `src` property |

## Recipe proof (ADR-102)

- `test/recipes.test.ts`: every outcome of every recipe on hand-written failing markup, with
  exact expected output for the edits.
- `test/recipe-properties.test.ts`: fast-check over generated markup; first run returns edits
  that re-parse and keep every code unit outside the edited spans (checked offset by offset
  through `mapOffset`); the run on the output returns `already-fixed`.
- `test/dawn-recipes.test.ts`: on pristine Dawn every recipe reports `already-fixed` (or the
  documented refusal); with each fix removed by a span edit, the recipe restores it, the full
  patch (file plus locale files, through `buildPatch`) passes `validateNoNewOffenses` with no
  new offenses, every code unit outside the edits is kept in the Liquid and locale files, and
  a second run reports `already-fixed`. `lang`, the Facebook link text and the search reset
  button come back byte-identical to Dawn.

## Plain Node smoke run

The engine will import the package through Node's own TypeScript support, not through Vitest.
Importing `./src/index.ts` with `node --input-type=module` (Node 26.12.0), running
`documentLanguage` on Dawn's `theme.liquid` with `lang` removed, `buildPatch`, `localeEdits` and
`validateNoNewOffenses` printed the expected one-line diff
(`-<html class="js">` / `+<html class="js" lang="{{ request.locale.iso_code }}">`),
`true 1` and `theme-check ok: true`: the CommonJS parser and Theme Check, ESM `diff` and UMD
`jsonc-parser` all load with named imports.

## Dawn fixtures (ADR-105)

```text
$ git clone --depth 1 https://github.com/Shopify/dawn.git dawn
$ git -C dawn log -1 --format='%H %cI %s'
258f00f64365e2018ca4c62778a6bf55a5d3cd18 2026-08-10T16:55:51-04:00 Dawn 16.0.0 (#3946)
$ git -C dawn ls-tree HEAD LICENSE.md layout/theme.liquid ... (blob ids in test/fixtures/dawn/SOURCE.json)
```

`LICENSE.md` is MIT text plus a Shopify field-of-use condition (quoted in ADR-105).
`test/fixtures.test.ts` recomputes each file's git blob id and matches all ten.

## Gate

Run from the worktree root before each commit.

| Command | Result |
| --- | --- |
| `pnpm install` | `Lockfile is up to date` / `Done` |
| `pnpm run lint` | `eslint --max-warnings=0 .` exits 0, no output |
| `pnpm run format:check` | `All matched files use Prettier code style!` |
| `pnpm run typecheck` | every package `Done`, including `packages/liquid-patch typecheck: Done` |
| `pnpm run knip` | exits 0, no findings |
| `node packages/claims-lint/src/main.ts` | `claims-lint: 1 file scanned, no banned claims` |
| `pnpm --filter @rampsmith/liquid-patch test` (`vitest run --coverage`, threshold lines 95%) | `Test Files  10 passed (10)`, `Tests  117 passed (117)`; `Statements 97.16%`, `Branches 91.59%`, `Functions 98.41%`, `Lines 99.13% ( 691/697 )` |
| `pnpm run test` | fails in `packages/queue` only: `DATABASE_URL must name a PostgreSQL 18 superuser connection for the tests`. This sandbox has no PostgreSQL 18 running, and starting one was refused by the session's permission policy; CI's `node` job provides the service container. `packages/liquid-patch` has no database tests. |

## For the integrator

Rows for `docs/adr/README.md` (this stream may not edit it):

```markdown
| [101](101-span-patch-engine.md) | Span patch engine: offsets, overlap rule, re-parse gate and diffs | Accepted |
| [102](102-recipe-contract.md) | Recipe contract and the rules of the six markup recipes | Accepted |
| [103](103-translation-keys-in-locale-files.md) | Translation keys for recipe labels, and what each locale file receives | Accepted |
| [104](104-theme-check-in-memory.md) | Theme Check runs in memory through `@shopify/theme-check-common` | Accepted |
| [105](105-dawn-fixtures-license.md) | Dawn test fixtures and Dawn's license | Accepted; license reading to confirm |
```

PLAN corrections to apply: ADR-103 (PLAN §12 form-label row) and ADR-104 (PLAN §7 engine
table), each with its exact replacement text.
