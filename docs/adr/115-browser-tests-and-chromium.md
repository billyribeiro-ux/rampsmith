# ADR-115: Browser tests on local fixtures; Playwright's Chromium in CI

- Status: Accepted
- Date: 2026-10-17 (fixture server revised after the security audit of `5bd9f99`, H1)
- Stream: WS-2 (custom checks and interactive states)

## Context

The browser checks and interactive-state scripts need a real Chromium. PLAN §11 pins Chromium
to the build bundled with Playwright 1.64.1 so results do not drift. The cloud sandbox cannot
download Playwright's browsers (`docs/ENVIRONMENT.md` on `main`), and its verified workaround is
`@sparticuz/chromium`. ci.yml's node job has no browser. `playwright-core` 1.64.1 (Apache-2.0)
has no install scripts and bundles the `playwright-core install` command
(`npm view playwright-core@1.64.1 bin` → `cli.js`); for 1.64.1 the Chromium headless shell is
156.0.8078.4, revision 1248 (`playwright-core install --dry-run --only-shell chromium`).
Playwright runs headless on the headless shell unless the `chromium` channel is chosen, and
`--only-shell` skips the full browser (https://playwright.dev/docs/browsers).

## Decision

- `@rampsmith/a11y-rules` declares `playwright-core` 1.64.1 as an exact peer dependency (the
  engine supplies the `Page`; an exact peer keeps the engine on the Playwright the rules were
  tested against) and as a dev dependency for its tests.
- `pnpm --filter @rampsmith/a11y-rules run test:browser` runs `test-browser/**/*.test.ts` in one
  worker, one file at a time, one Chromium per file. Fixtures are local HTML files served by a
  Node HTTP server on the loopback interface (`127.0.0.1`, a random port), because the checkout
  guard fetches same-store requests itself (`route.fetch`, ADR-116) and request interception
  alone cannot answer it; the server also plays the hostile store (redirects into checkout) and
  logs every request, which is the witness for the guard tests. A context route aborts and
  records every request to any other origin, and each test asserts the list is empty: nothing
  leaves the machine. Every fixture context is created with `scanContextOptions()`, except the
  one test that proves the guard refuses a context allowing Service Workers (loopback is a
  secure context, so pages there can register them). The 5-second WAV tone is generated in the
  harness, so no binary fixture is committed.
- Fixtures: `clean.html`, a Dawn-like product page with no seeded failure on which every check
  returns nothing (at 1280 × 800 and at 390 × 844) and every state opens; one `seeded-*.html`
  per browser check, plus `seeded-sticky-drawer.html` for a sticky header and a drawer; and
  `no-states.html`, `sold-out.html`, `nav-navigates.html` and the `guard-*.html` fixtures for
  the state scripts and their guards (ADR-116).
- The test launcher reads two optional variables, never read by package code:
  `CHROMIUM_EXECUTABLE_PATH` and `CHROMIUM_ARGS` (a JSON array). Without them it launches
  Playwright's own Chromium.
- `.github/workflows/a11y-rules.yml` runs on pull requests touching `packages/a11y-rules/**` or
  the workflow itself: ci.yml's node-job setup with the same pinned actions, then
  `playwright-core install --with-deps --only-shell chromium` from the locked package, then the
  browser tests. Top-level `permissions: {}`, job `contents: read`.
- `@sparticuz/chromium` is not a dependency of anything in the repository. In the sandbox it is
  installed outside the repository and passed in through the two variables, with
  `CHROMIUM_ARGS='["--no-sandbox"]'` (the sandbox runs as root). Its `--single-process` switch
  is not used: with it, Chromium stopped responding after a context closed and later tests
  failed with "Target page, context or browser has been closed" (evidence file).

## Consequences

- CI is the authority for the pinned Chromium (156.0.8078.4); local runs use Chromium
  153.0.8010.0 from `@sparticuz/chromium` 153.0.0, three major versions older. A difference
  between them shows up as a red CI run and is investigated, never suppressed.
- The browser tests are a required signal only once the workflow is made a required check
  (repository settings, at integration).

## Rejected alternatives

- Committing `@sparticuz/chromium` as a dev dependency: it would install a second, unpinned
  browser for everyone and differs from the Chromium the plan pins.
- Running the browser tests in ci.yml's node job: ci.yml is not this stream's file, and the
  plan keeps that job browser-free.
