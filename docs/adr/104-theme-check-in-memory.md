# ADR-104: Theme Check runs in memory through `@shopify/theme-check-common`

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-1 (`packages/liquid-patch`)

## Context

PLAN §12 says a patched file must "re-parse cleanly and pass `theme-check` with no new errors",
and PLAN §7 pins `@shopify/theme-check-node` 3.30.1 for the engine. `liquid-patch` is a pure
library: it receives file contents, not a checked-out theme, and must not touch the network
or write files.

Evidence, read on 2026-10-17:

- `npm view @shopify/theme-check-node@3.30.1`: MIT; depends on `@shopify/theme-check-common`
  3.30.1, `@shopify/theme-check-docs-updater` 3.30.1, `@shopify/theme-graph`, `glob`, `yaml`
  and `vscode-uri`. Its `check(root)` reads a theme directory from disk through a Node file
  system, and the docs updater (`ThemeLiquidDocsManager`) downloads Shopify's Liquid reference
  from `https://raw.githubusercontent.com/Shopify/theme-liquid-docs/main`, falling back to
  data bundled in the package (`dist/themeLiquidDocsDownloader.js`, `data/`).
- `npm view @shopify/theme-check-common@3.30.1`: MIT, released 2026-10-01, no peers; its
  dependencies are MIT or ISC (`lodash`, `postcss`, `minimatch`, `vscode-uri`, `cross-fetch`,
  `line-column`, `jsonc-parser`, `postcss-safe-parser`, `postcss-selector-parser`,
  `vscode-json-languageservice`). It exports `check(theme, config, dependencies)`, where the
  theme is a list of `{uri, source}` and `dependencies.fs` is an injected
  `AbstractFileSystem`; Shopify's Liquid reference (`themeDocset`) is optional.
- In its source, only `checks/asset-size-css` and `checks/asset-size-javascript` call
  `fetch` (through `utils/file-utils.js`, for remote asset sizes); neither is in the
  `recommended` set.
- Run on Node 26.12.0 against the vendored Dawn files with an in-memory file system: all 85
  recommended checks (none of them a network check) in about 140 ms, no crashed check. Tests prove it reports
  `TranslationKeyExists` for a key missing from the default locale, `MatchingTranslations`
  for locales missing a key the default has, `ImgWidthAndHeight`, and `UnusedAssign`
  (`test/theme-check.test.ts`).

## Decision

1. `liquid-patch` depends on `@shopify/theme-check-common` 3.30.1, not on
   `@shopify/theme-check-node`, and runs it over in-memory snapshots (`file:///theme/<path>`).
2. The check list is Shopify's `recommended` set minus the four asset-size checks
   (`OFFLINE_CHECKS`; in 3.30.1 none of the four is recommended, so all 85 run). The filter
   guards a future release that recommends one; a test asserts the network checks are absent.
3. `validateNoNewOffenses(before, after)` runs both snapshots and reports offenses in `after`
   beyond those in `before`, matched by file, check and message (positions move when a patch
   inserts text), as a multiset. By default both errors and warnings count, which is stricter
   than the plan's "no new errors"; `includeWarnings: false` gives the plan's exact rule. A
   check that throws is reported as a `CheckCrashed` error, so a crash cannot pass silently.
4. Shopify's Liquid reference is optional (`themeDocset`); without it, the checks that need it
   (`UnknownFilter`, `UndefinedObject`, `DeprecatedFilter` and similar) find nothing. The
   engine can pass the docs manager from `@shopify/theme-check-docs-updater`; a test proves
   the reference reaches the checks.
5. Every recipe test on Dawn builds the full patch (file plus locale files) and requires
   `validateNoNewOffenses` to return no new offenses, alongside ADR-101's re-parse gate.

## Consequences

- The gate runs offline and deterministically in unit tests and in the engine alike.
- Checks that need the whole theme (`MissingAsset`, `MissingTemplate`) report references to
  files outside the snapshot; comparing before and after cancels them, so callers should pass
  every file the patch touches plus its locale files, and may pass more.
- Without the docset, a recipe that printed an unknown filter would not be caught by Theme
  Check; recipes print only `t`, `escape` and object properties, covered by their own tests.

## Plan correction

PLAN §7, "Engine (`engine`)" table, replace the `@shopify/theme-check-node` row with:

```markdown
| `@shopify/theme-check-common` | 3.30.1 | MIT; `liquid-patch` runs Shopify's recommended checks in memory over patched files, offline (ADR-104). `@shopify/theme-check-node` is not needed unless a later task lints whole theme directories on disk |
```

## Rejected alternatives

- `@shopify/theme-check-node`: needs the theme on disk, which would mean writing temporary
  files, and its docs manager reaches the network.
- Keeping only the re-parse gate: misses Shopify-specific errors such as a missing
  translation key, which is exactly what a label recipe could cause.
