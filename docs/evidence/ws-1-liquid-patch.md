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
| `diff` | 9.0.0 (latest) | BSD-3-Clause | engines node >=0.3.1; no dependencies | 2026-04-13 | Unified diffs (ADR-101) |
| `jsonc-parser` | 3.3.1 (latest) | MIT | none; no dependencies | 2024-06-24 | JSON offsets for locale edits and JSON validation (ADR-101, ADR-103) |
| `fast-check` (dev) | 4.10.2 (latest) | MIT | engines node >=12.17.0; dependency `pure-rand` ^8.0.0 (MIT, 8.4.2) | 2026-09-19 | Property tests |
| `vitest` (dev) | 5.0.5 (latest; same pin as `packages/queue`) | MIT | `@types/node` ^22.0.0 \|\| >=24.0.0 (root has 26.6.5); engines node ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0 | 2026-10-15 | Test runner |

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
| `pnpm --filter @rampsmith/liquid-patch test` | `Test Files  5 passed (5)`, `Tests  53 passed (53)` |
| `pnpm run test` | fails in `packages/queue` only: `DATABASE_URL must name a PostgreSQL 18 superuser connection for the tests`. This sandbox has no PostgreSQL 18 running, and starting one was refused by the session's permission policy; CI's `node` job provides the service container. `packages/liquid-patch` has no database tests. |
