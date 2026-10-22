# Evidence: marketing site, pricing page and free scanner (LAUNCH.md section B, item 1)

Branch `r1-site`, built 22 October 2026 on `main` at `d201f2b`. Node 26.12.0, pnpm 12.14.0.
Local runs used `@sparticuz/chromium` 153.0.0 through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
(`docs/ENVIRONMENT.md`); CI runs the pinned Playwright browser.

## What was built

| Page | Route | Notes |
| --- | --- | --- |
| Home | `/` | Heading and lede unchanged from the earlier root page (`app.spec.ts` still asserts them) |
| How it works | `/how-it-works` | Steps, fix channels, what is checked, what stays with a person |
| Pricing | `/pricing` | PLAN §20 table with ADR-141's Starter channel; gated features in a matrix, labelled with the unlocking plan |
| Free scanner | `/scan` | Turnstile, caps, 24-hour cache; "not connected yet" until the engine accepts anonymous scans (ADR-260) |
| Accessibility statement | `/accessibility` | `docs/accessibility-statement.md`, draft banner, noindex |
| Privacy, terms, DPA | `/privacy`, `/terms`, `/dpa` | `docs/legal/*.md`, "Draft — attorney review required. Not published.", noindex |
| Subprocessors | `/subprocessors` | PLAN §19's table, draft banner, noindex |

## Tests

| Suite | Result |
| --- | --- |
| `pnpm --filter @rampsmith/web test` (Vitest) | 144 passed (107 of them new): URL guard 29, limits 7, Turnstile 11, service 12, CSP 5, Markdown 14, plans 10, dark tokens 19, plus the existing suites |
| `playwright test` project `site` | 75 passed, 1 skipped (the live Turnstile check) |
| Existing project `embedded` (`app.spec.ts`) | 10 passed, so the moved home page and the pinned policy still hold |
| Project `dashboard` | Needs the Rust api binary and PostgreSQL; not run locally, unchanged by this branch (CI runs it) |

Inside the 76 site tests:

- axe (WCAG 2.0, 2.1 and 2.2 A and AA tags), zero violations: 18 page runs (9 pages, light and
  dark), 9 runs at a 320 px viewport, and the scanner's not-connected, validation, result (light
  and dark), limit and closed states. Dark mode uses `colorScheme: 'dark'`.
- Keyboard: 18 Tab walks (every stop shows a 2 px or thicker outline, is on screen, and the walk
  leaves the page, so there is no trap), skip link on all 9 pages, header navigation by Enter, the
  scrollable table region scrolled with the arrow keys, 200% text, and the whole scan flow by
  keyboard.
- Headers: every page except `/scan` carries exactly the pinned policy (`tests/csp.ts`); `/scan`
  carries it plus Turnstile's origin in `script-src` and `frame-src`; draft pages send
  `X-Robots-Tag: noindex, nofollow` and a meta tag; result and error responses are
  `private, no-store`.
- Scanner: the bot check is verified on the server (secret, token and visitor address seen by
  the stand-in), a missing, made-up or replayed token is refused, a browser without JavaScript
  gets a plain form and a clear message, 3 scans per IP and a 24-hour cache per domain on the
  fixture backend, and a server without Turnstile keys keeps the scanner closed.

## Section E rule for the Turnstile input (LAUNCH.md row C6)

1. Substitute passing now: `tests/site-turnstile-fake.ts` stands in for Cloudflare (script,
   siteverify, single-use tokens), used by `site-scanner.spec.ts`.
2. Live test: `tests/site-turnstile-live.spec.ts` runs when `TURNSTILE_SECRET_KEY` is set and
   otherwise skips with: "SKIPPED: needs LAUNCH.md section C, row 6 ...".
3. Row added to LAUNCH.md section E with the command.

## Local gate

`pnpm install`, `pnpm --filter @rampsmith/web run sync`, `pnpm run lint` (0 problems),
`pnpm run typecheck` (0 errors, 0 warnings), `pnpm run knip`, `pnpm run format:check`,
`node packages/claims-lint/src/main.ts` (126 files, no banned claims),
`node packages/node-pins/src/main.ts`.

## Facts checked against official sources

- Turnstile siteverify, rendering and CSP: Cloudflare's documentation, 22 October 2026 (ADR-261).
- "Automated testing finds on average 57% of WCAG issues": axe-core 4.14.0's README (the copy in
  `node_modules`).
- Prices, yearly prices, allowances and the Starter channel: read from `docs/PLAN.md` by
  `plans.test.ts` on every run.
