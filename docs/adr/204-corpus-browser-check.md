# ADR-204: Proving golden findings with axe-core in Chromium, inside ci.yml's node job

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-11 (`packages/corpus-tools`)

## Context

Golden findings are only useful if they are exactly what the scanner reports: a missing one
inflates accuracy, an extra one hides a failure. PLAN §11 fixes the scanner: axe-core restricted
to `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa`, Chromium bundled with Playwright
1.64.1. Spike S-1 on `r0-foundations` (docs/spikes/S-1-axe-tags-and-target-size.md) found that
`target-size` is disabled by default and runs only through a tag-based `runOnly`.

This stream owns no workflow file, and ci.yml's node job runs `pnpm -r test` without installing
a browser. docs/ENVIRONMENT.md records that Playwright's download is blocked in the cloud
environment, where `@sparticuz/chromium` 153.0.0 stands in.

Registry evidence, `npm view` on 2026-10-17: `axe-core` 4.14.0 (MPL-2.0, already locked for
`apps/web`) and `playwright-core` 1.64.1 (Apache-2.0, already locked), whose `browsers.json`
pins Chrome Headless Shell 156.0.8078.4. `ajv` 8.20.0 (MIT) validates the schemas.

## Decision

1. **Check**: each page is rendered (ADR-202), served to a fresh Chromium context at 1280×800,
   locale `en-US`, timezone UTC, reduced motion, through request interception on
   `http://storefront.corpus.test`; every other origin is aborted. axe-core 4.14.0 runs with
   `runOnly` on the scanner's tags, `resultTypes` violations and incomplete, no iframe
   injection, and element references. Result nodes and golden selectors are compared as elements
   (their index in document order), so the comparison does not depend on how axe writes its
   targets.
2. **Exactness**: per page, the `(rule, outcome, element)` set must equal the golden set, with the
   golden impact and selector counts; every golden rule must have run; a control must have no
   violation and no incomplete result. Incomplete results are golden findings too (axe's
   `bypass` reports only as incomplete), never ignored.
3. **Chromium**: `scripts/ensure-chromium.ts` runs before Vitest. With `CI=true` it installs the
   headless shell bundled with the locked playwright-core through playwright-core's own installer,
   so ci.yml's node job checks on the pinned Chromium without a workflow change; in run
   39087288762 the node job downloaded Chrome Headless Shell 156.0.8078.4 and passed, and run
   39088109891 passed all eight jobs. Elsewhere `CHROMIUM_EXECUTABLE_PATH`
   and `CHROMIUM_ARGS` select another build, as `packages/a11y-rules` does; without either, the
   script fails with the fix rather than skipping.
4. **Custom rules**: findings of `@rampsmith/a11y-rules` rules are listed in the goldens with the
   same occurrence format; their selectors are checked now, and their firing at integration, when
   that package is in the workspace (CONTRACT.md, check 6). Nothing is reported as passing that
   did not run.

## Consequences

- Every pull request proves 47 golden axe-core findings on 17 failing-theme pages and zero results
  on 17 control pages, in about 4 seconds of browser time.
- Local runs use Chromium 153 and CI Chromium 156; the corpus avoids layout-sensitive edge cases
  (text over images, font-dependent target sizes) so both agree, and CI is the gate.

## Rejected alternatives

- A separate workflow for the browser check: this stream may not add workflow files; the node job
  already runs every package's tests.
- Skipping the browser check when no Chromium is present: a skipped test is not a pass.
- `@axe-core/playwright`: it adds a dependency for what one `addScriptTag` and one `evaluate` do.
