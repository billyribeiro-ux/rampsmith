# Evidence: WS-2 custom checks and interactive states (`packages/a11y-rules`)

Recorded in the Claude Code cloud environment on 17 October 2026 (Node 26.12.0, pnpm 12.14.0,
2 vCPUs). Branch `ws/a11y-rules` from `r0-foundations` at `e43f546`. Every block is the command
and its output, trimmed to the lines that matter.

## 1. Dependencies, read from the live registry

```console
$ npm view parse5@8.0.1 version license engines peerDependencies dependencies --json
{ "version": "8.0.1", "license": "MIT", "dependencies": { "entities": "^8.0.0" }}
$ npm view parse5 dist-tags --json
{ "test": "4.0.0-test", "latest": "8.0.1" }
$ npm view entities@8.1.0 version license engines --json
{ "version": "8.1.0", "license": "BSD-2-Clause", "engines": { "node": ">=20.19.0" }}
$ npm view fast-check@4.10.2 version license engines dependencies --json
{ "version": "4.10.2", "license": "MIT", "engines": { "node": ">=12.17.0" }, "dependencies": { "pure-rand": "^8.0.0" }}
$ npm view fast-check dist-tags --json
{ "legacy": "2.15.1", "next": "3.0.0-alpha.2.25.0.0", "latest": "4.10.2" }
$ npm view pure-rand version license --json
{ "version": "8.4.2", "license": "MIT"}
$ npm view vitest@5.0.5 version license engines --json
{ "version": "5.0.5", "license": "MIT", "engines": { "node": "^22.12.0 || ^24.0.0 || >=26.0.0" }, ...}
$ npm view playwright-core@1.64.1 version license engines bin --json
{ "version": "1.64.1", "license": "Apache-2.0", "engines": { "node": ">=20" }, "bin": { "playwright-core": "cli.js" }}
$ npm view playwright-core@1.64.1 scripts      # no lifecycle scripts, so pnpm's allowBuilds is untouched
$ npm view @sparticuz/chromium@153.0.0 version license engines --json
{ "version": "153.0.0", "license": "MIT", "engines": { "node": "^22.17.0 || >=24.0.0" }}
```

| Package | Version | Where | License | Peer ranges / engines |
| --- | --- | --- | --- | --- |
| `parse5` | 8.0.1 | dependency | MIT | engines not declared; depends on `entities ^8.0.0` (locked 8.1.0, BSD-2-Clause) |
| `fast-check` | 4.10.2 | devDependency | MIT | node >=12.17.0; depends on `pure-rand ^8.0.0` (locked 8.4.2, MIT) |
| `vitest` | 5.0.5 | devDependency | MIT | the repository's pin (PLAN §7) |
| `@rampsmith/tsconfig` | workspace | devDependency | — | — |
| `@sparticuz/chromium` | 153.0.0 | not a dependency: installed outside the repository for local runs only (ADR-115) | MIT | node ^22.17.0 \|\| >=24.0.0 |

## 2. parse5 offsets and the cost of deep nesting (ADR-111)

A scratch script (not committed) parsed fragments with `sourceCodeLocationInfo: true`:

```console
$ node p5-tmp.mjs
"a\r\nb<p>x</p>" p [ 4, 12, '"<p>x</p>"', [ 4, 7 ] ]
"😀😀<h2>t</h2>" h2 [ 4, 14, '"<h2>t</h2>"', [ 4, 8 ] ]
"\r\r\n\u0000<img src=x>" img [ 4, 15, '"<img src=x>"', [ 4, 15 ] ]
"<table><tr><td>a</td></tr></table>" tbody null
"<a href=x>click\r\n here</a>" a [ 0, 26, '"<a href=x>click\\r\\n here</a>"', [ 0, 10 ] ]
deep parse ms 287313        # '<div>'.repeat(200000) + 'x'
big parse ms 2242 2160000   # 40,000 shallow paragraphs, 2.16 MB
formatting ms 100           # '<b>'.repeat(50000)
table ms 54                 # '<table>'.repeat(20000)
```

Offsets are UTF-16 string indices into the original input (CR LF and astral characters
included); parser-implied elements such as `tbody` have no location. 200,000 nested `<div>`s
took 287 s, which is why the parser runs behind the depth, element and time limits of ADR-111.
With the limits, the same input is refused as `too_deep` in milliseconds
(`test/rich-text.test.ts`, "refuses nesting deeper than the depth limit, quickly").

## 3. Gate runs

Commit 1 (`feat(a11y-rules): add the data audit ...`), from the worktree root:

```console
$ pnpm install
Done in 31ms using pnpm v12.14.0
$ pnpm run lint
$ eslint --max-warnings=0 .
$ pnpm run format:check
All matched files use Prettier code style!
$ pnpm run typecheck
packages/a11y-rules typecheck: Done
$ pnpm run knip
$ knip
$ pnpm --filter @rampsmith/a11y-rules run test
 Test Files  6 passed (6)
      Tests  62 passed (62)
$ node packages/claims-lint/src/main.ts
claims-lint: 1 file scanned, no banned claims
```

`pnpm run test` (every package) passes in every package except `packages/queue`, whose suites
need `DATABASE_URL` naming a PostgreSQL 18 server. None runs in this session: starting one was
refused by the session's permission policy. CI's node job provides it as a service container.
`test:browser` arrives with the browser checks in the next commit; its runs are recorded there.
