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
| `playwright-core` | 1.64.1 | exact peerDependency and devDependency (ADR-115) | Apache-2.0 | node >=20; no lifecycle scripts; the PLAN §7 Playwright pin |
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

## 4. Chromium for the browser tests (ADR-115)

```console
$ pnpm --filter @rampsmith/a11y-rules exec playwright-core install --dry-run --only-shell chromium
Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248)
  Download url:        https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip
$ pnpm --filter @rampsmith/a11y-rules exec playwright-core install --help | grep shell
  --only-shell   only install headless shell when installing chromium
  --no-shell     do not install chromium headless shell
```

CI installs that build (`.github/workflows/a11y-rules.yml`). Here, its CDN is blocked, so
`@sparticuz/chromium` 153.0.0 was installed in the session scratchpad (not the repository) and
`await chromium.executablePath()` printed `/tmp/chromium`; `browser.version()` printed
`153.0.8010.0`. Facts measured with it:

- Tab after the last element puts focus on `body`, and the next Tab returns to the first
  element: leaving the page is the end of a normal cycle.
- `blur()` then `focus()` after keyboard navigation matches `:focus-visible`, so the screenshot
  confirmation sees the keyboard focus style.
- Unmuted `<audio autoplay>` stays `paused` (autoplay policy) while `duration` is known
  (`5`, `readyState` 4), which is why the check uses the `autoplay` attribute, not playback.
- With `CHROMIUM_ARGS='["--no-sandbox","--no-zygote","--single-process"]'` the first browser
  test passed, the second timed out after 60 s and every later `browser.newContext` failed with
  "Target page, context or browser has been closed". With `CHROMIUM_ARGS='["--no-sandbox"]'`
  every test passes. `--no-sandbox` is needed only because the sandbox runs as root.

## 5. Gate runs for the browser checks and state scripts

Commit 2 (`feat(a11y-rules): add the browser checks, interactive-state scripts ...`), from the
worktree root:

```console
$ pnpm install
Done in 32ms using pnpm v12.14.0
$ pnpm run lint
$ eslint --max-warnings=0 .
$ pnpm run format:check
All matched files use Prettier code style!
$ pnpm run typecheck
packages/a11y-rules typecheck: Done
$ pnpm run knip
$ knip
$ pnpm --filter @rampsmith/a11y-rules run test
 Test Files  7 passed (7)
      Tests  72 passed (72)
$ CHROMIUM_EXECUTABLE_PATH=/tmp/chromium CHROMIUM_ARGS='["--no-sandbox"]' \
    pnpm --filter @rampsmith/a11y-rules run test:browser
 Test Files  2 passed (2)
      Tests  19 passed (19)
   Duration  6.74s
$ node packages/claims-lint/src/main.ts
claims-lint: 1 file scanned, no banned claims
```

`pnpm run test` across the workspace: as in section 3, only `packages/queue` fails, for want of
`DATABASE_URL`.

Commit 3 (`fix(a11y-rules): keep the checkout guard for the page's life ...`): the same gate,
all passing; `pnpm --filter @rampsmith/a11y-rules run test` → `Test Files 8 passed (8)`,
`Tests 77 passed (77)`; `test:browser` (same variables) → `Test Files 2 passed (2)`,
`Tests 22 passed (22)`, 7.87 s.

Commit 4 (`fix(a11y-rules): judge a clipped focus stop by its containing block`): the same
gate, all passing; `test` → 77 passed; `test:browser` → `Tests 23 passed (23)`, 8.47 s,
including the clean page at 390 × 844.

## 6. Attribute count (ADR-111)

```console
$ node attr-tmp.mjs        # scratch script, not committed; one <div> with n distinct attributes
5000 23680 112 ms
20000 98680 1229 ms
40000 198680 6626 ms
dup 20000 80013 18 ms      # the same attribute repeated: parse5 drops duplicates cheaply here
dup 80000 320013 26 ms
```

After the pre-scan: the 40,000-attribute tag, the same behind a `"` in a name, and an end tag
with 40,000 attributes are each refused as `too_many_attributes` in under 2 s (6 ms measured),
and a megabyte of tags with 256 attributes each parses in 390 ms (`test/rich-text.test.ts`).

Commit 6 (`test(a11y-rules): seed focus hidden by a sticky header and by a drawer`): the same
gate, all passing; `test` → 80 passed; `test:browser` → `Tests 24 passed (24)`, 8.34 s. The
sticky-header case is found only by the backward pass, as ADR-114 expects.

## 7. Security audit of `5bd9f99`: data-audit findings (H2, H3, M6, L7)

The auditor's probes (`a11y-probe/*.mjs` in the session scratchpad), rerun after the fix, from
`packages/a11y-rules`:

```console
$ node a11y-probe/prescan.mjs 60000
input chars 312017
plain tag (should be refused fast): 1 ms "too_many_attributes"
same tag after <!-- <a x=" --> : 3017 ms "time_limit"          # audit: 10.5 s, "audited"
same tag after <script><a x="</script>: 3002 ms "time_limit"
auditRichText via comment: 3037 ms "not_audited"
$ node a11y-probe/labelledby.mjs 20900
links=20900 chars=996416 status=audited  findings=1000 342 ms   # audit: 10.8 s
$ node --expose-gc a11y-probe/memory.mjs
chars=495000 status=audited findings=1000 heapDelta=89 MB rss=210 MB 274 ms   # before: 3011 ms, time_limit
$ node a11y-probe/regex.mjs dim 20000
filenamePattern digits+z: n=20000 0 ms null                   # audit: 1.17 s
auditRichText <img alt=digits+z>: n=20000 13 ms "audited"
$ node a11y-probe/regex.mjs ext 20000
filenamePattern (.png?)*+\nx: n=20000 0 ms null
$ node a11y-probe/regex.mjs menu 200000
auditMenu two duplicate items with slash-run url: n=200000 1 ms 0   # before: 89 s in the test
```

Measured before the fix while writing the regression tests: 100,000 `<img>` siblings took
8.4 s in plain parse5 (`parseFragment`, the O(n) first-child splice when the fragment root's
children move); `x<i></i>` × 100,000 took 18.4 s. Each probe is now a regression test:
`test/rich-text.test.ts` ("stops attribute floods hidden behind a comment, script or CDATA
prefix", "parses many sibling elements in linear time", "moves the children of a misnested
block in linear time", "caps the findings of one field and says so", "resolves a shared
aria-labelledby target once", "checks hostile alt text in linear time"),
`test/media-alt.test.ts` ("filenamePattern on hostile alt text"), `test/menu.test.ts`
("compares destinations in linear time"), and `test/property.test.ts` ("builds the same tree
and offsets whatever the chunk size").

## 8. Security audit of `5bd9f99`: guard findings (H1, M4, M5, L8, L9)

The auditor's `a11y-probe/guards.mjs`, run against the new guards (with `target: ''` added to
its control shape, a field the probe now always reports):

```console
guardControl: /cart/add form with return_to=/checkout    {"safe":false,"guard":"checkout","detail":"field return_to"}
isCheckoutRequest POST /cart/add body return_to=%2Fcheckout              true    # audit: false
isCheckoutRequest POST /cart/update body checkout=                       true    # audit: false
isCheckoutRequest POST /cart body check%6Fut=                            true    # audit: false
isCheckoutUrl /check%6Fut                                                true    # audit: false
isCheckoutUrl /%63heckouts/cn/x                                          true    # audit: false
isCheckoutUrl /discount/SAVE?redirect=/checkout                          true    # audit: false
isCheckoutUrl /cart/add?id=1&return_to=/checkout                         true    # audit: false
guardControl link to off-store https://evil.example/     {"safe":false,"guard":"navigation","detail":"link leaves the store"}
guardControl link javascript:window.open(...)            {"safe":false,"guard":"navigation","detail":"link is not http(s)"}
guardControl form-associated custom element              {"safe":false,"guard":"personal_data","detail":"custom form control gift-email"}
guardControl pay.shopify.com link                        {"safe":false,"guard":"navigation","detail":"link leaves the store"}
```

Measured while building the redirect guard: with the first design (fulfil the 302 and let the
browser follow), the two-hop fixture `guard-chain.html` returned `not_found` with no trip,
because Chromium followed `/hop` without the context route seeing it; the guard now follows each
hop itself and the test passes. The Playwright facts quoted in ADR-116 were read from
`node_modules/playwright-core/types/types.d.ts` ("The handler will only be called for the first
url if the response is a redirect") and its server bundle (the `serviceWorkers: 'block'` init
script and `BrowserContextAPIRequestContext._defaultOptions`, which uses the context or launch
proxy). The Shop Pay URL shapes come from
https://shopify.dev/docs/api/hydrogen/latest/shop-pay/get-shop-pay-button-url.

Regression tests: `test/guards.test.ts` (every probe line, `readControlDescription`,
`screenRequest`), and `test-browser/guards.test.ts`: "stops a form post the server redirects into
checkout", "meets every hop of a redirect chain", "closes a popup the theme opens and stops its
checkout request", "refuses a form or button that targets a new window", "stops a cart post that
carries return_to", "blocks service worker registration in a scan context", "refuses to run in a
context that lets pages register service workers", "ignores a fake probe planted by the page",
"refuses a form that holds a form-associated custom element", "blocks a page post to a non-cart
endpoint while guarded", "never triggers an off-store link and stops a scripted off-store
navigation", "brings the page back after a script navigated it away".

Gate for this commit (`fix(a11y-rules): guard the whole context ...`): `pnpm install`, `lint`,
`format:check`, `typecheck`, `knip` all pass; `pnpm --filter @rampsmith/a11y-rules run test` →
`Test Files 8 passed (8)`, `Tests 102 passed (102)`; `test:browser` (same variables as
section 5) → `Test Files 3 passed (3)`, `Tests 36 passed (36)`, 13.11 s; claims-lint → no banned
claims; `pnpm install --frozen-lockfile` passes. The workspace-wide `pnpm run test` still fails
only in `packages/queue` for want of `DATABASE_URL`.

## 9. Merge with `r0-foundations` and CI (19 October 2026, third stream wave)

Agent W3 brought the branch to merge-ready. Pull request #9 (draft, into `r0-foundations`,
"WS-2: Custom rules and states (do not merge; stream CI)").

**The merge.** `origin/r0-foundations` at `6bb8116` merged in by merge commit `e7177c3`; no
history was rewritten. One conflict, `pnpm-lock.yaml`: r0-foundations' lockfile was taken and
pnpm 12.14.0 regenerated the `packages/a11y-rules` importer (parse5 8.0.1, fast-check 4.10.2,
playwright-core 1.64.1, with entities 8.1.0 and pure-rand 8.4.2 underneath). Versions are the
ones in section 1; nothing was bumped. Two changes inside owned paths, both in the merge commit,
because `check:node-pins` on `r0-foundations` failed without them:

- `packages/a11y-rules/package.json`: `"engines": { "node": ">=26.12.0 <27" }`.
- The workflow `a11y-rules.yml`: a step "Node version (ADR-029)" that runs `node --version`,
  `node -p 'process.release.lts ?? "not an LTS release"'` and checks the installed version
  against the pin in `.mise.toml`, as the pin check requires of a job that installs Node.

The workflow's actions were already pinned by SHA and its images by digest; nothing else changed.

**CI on head `e7177c3`.**

| Workflow | Run | Conclusion |
| --- | --- | --- |
| `ci.yml` | [39285493653](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39285493653) | success (rust, node, contracts, e2e, four image builds) |
| `a11y-rules.yml` | [39285493814](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39285493814) | success (job `browser`) |

The `browser` job's log (job 118170124500) shows the Chrome Headless Shell 156.0.8078.4 build
that section 4 predicted, and:

```text
$ pnpm --filter @rampsmith/a11y-rules run test:browser
 Test Files  3 passed (3)
      Tests  36 passed (36)
   Duration  12.14s
```

Test counts: browser 36 passed in CI, the same as section 8's local run (there on
`@sparticuz/chromium` 153, here on 156, so the checks pass on both builds). The 102 unit tests of
section 8 run in the `node` job of `ci.yml` (conclusion success); their count is read here from
section 8's local run, not from the CI log.

**Integration notes.**

1. `docs/adr/README.md` has no rows for ADR-111 to ADR-116.
2. The workflow `a11y-rules.yml` is separate from `ci.yml`; the builder's R1 lanes need this
   package, so the branch is the first of the four to merge.
3. Nothing outside the stream's paths changed except `pnpm-lock.yaml`, by pnpm.
