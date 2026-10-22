# R1 lane C evidence: App Home and AI alt text

Branch `r1-apphome`. Local gate on Node 26.12.0, pnpm 12.14.0, PostgreSQL 18.4 (embedded binaries,
docs/ENVIRONMENT.md). CI is authoritative.

## Increment 1: `ai.alt_text@1` (ADR-090)

- `npm view`: `sharp@0.35.5`, Apache-2.0, no install script, published 2026-09-27;
  `pnpm install` completed without an `allowBuilds` decision.
- `DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm --filter @rampsmith/engine exec vitest run`:
  13 files passed, 1 skipped; 143 tests passed, 1 skipped (the live check, "needs ANTHROPIC_API_KEY
  (LAUNCH.md section C, row 5)").

## Increment 2: the embedded App Home (ADR-091 to ADR-095)

Screens built under `apps/web/src/routes/app/`: overview with scan status and start-scan; ranked
issue list with impact, origin and fix filters; issue detail with the WCAG criterion, evidence,
occurrences and fixes; alt-text review queue with approve, edit, reject and one-click undo;
remediation log with CSV and JSON export (made by `packages/reports`); accessibility statement
generator with a live preview and saved versions; settings with the weekly-rescan opt-in, the AI
limits and the storefront password; plan-gated features shown, labelled and disabled from the
api's entitlements. Every string is a Paraglide message with the `app_` prefix (`messages/en.json`).

Local gate on Node 26.12.0 (CI is authoritative):

- `pnpm --filter @rampsmith/web exec svelte-check --fail-on-warnings`: 0 errors, 0 warnings.
- `pnpm run lint` (ESLint `--max-warnings=0`), `pnpm run knip`, `pnpm run format:check`,
  `node packages/claims-lint/src/main.ts` (no banned claims), `node packages/node-pins/src/main.ts`: clean.
- `pnpm --filter @rampsmith/web exec vitest run`: 9 files, 95 tests passed (the proxy table, the
  media rules, the report mappings and the existing web suites).
- Playwright, projects `app-home` and `embedded`, Chromium from `/opt/google/chrome/chrome`:
  67 passed (57 `app-home`, 10 `embedded`).
  - `app-axe.spec.ts`: 28 tests. Axe with the tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa and
    zero violations on every screen: overview (default, free, fresh, empty, error), issue list
    (default, empty, error), image issue (default, error), page issue, fix review (default, free,
    fresh, error), remediation log (default, fresh, error), statement (default, fresh, error),
    settings (default, free, starter, error), plus the fix editor with and without a validation
    error, the settings form with errors, and the statement preview before and after saving.
  - `app-keyboard.spec.ts`: 8 tests. Approve, edit (Escape, Save), refused empty and over-long edits,
    undo, reject, focus to the empty message when the last card leaves, Tab order through the
    queue, and the settings form, all by key press; each asserts where focus lands and what the
    live region says.
  - `app-screens.spec.ts`: 20 tests on contents, filters, exports (the CSV and JSON files are
    read back), statement preview and save, settings save and refusal, the Free plan gates, the
    expired-token retry, and that every api request carried the session token.
  - `app-journey.spec.ts`: 1 test, the scripted install-to-first-fix journey with axe at each
    step: open, start the scan, wait for results, open the queue, approve with the keyboard, see it
    applied, find it in the log, undo. It attaches `journey-steps.json` and fails over ten minutes.
    Against the fake api it takes about 13 s; that bounds the app's own polling and steps only.
- `tests/app.spec.ts` (`embedded`): its three "installed on" assertions now wait for the overview's
  empty state, because `/app` now shows the overview; `tests/mock-api.ts` answers
  `GET /v1/shopify/overview` for it.

Polaris elements used, checked against the published manifest (not a dependency, ADR-094):
`npm pack @shopify/polaris-types@1.1.0` (the version of the pinned `polaris-1.1.js`) and compare
`dist/custom-elements.json` with every `<s-*>` in `apps/web/src/**/app`: 20 tags, every attribute
and every `slot` exists, except `rel` on `s-link` (App Bridge's app-nav only). The package has
no `license` field, so it was not added to `package.json`.

Known gaps:

- The real Polaris components, App Bridge and the save bar are not exercised (Shopify is
  unreachable); the shim stands in. Proposed LAUNCH.md rows below.
- Product images use the media route, which needs the Shopify CDN; the specs show the text
  placeholder ("Image unavailable") that a failed fetch shows. `media.server.test.ts` covers
  the rules.
- The api handlers behind `/v1/shopify/` are lane A's; the contract is ADR-091.

### Proposed LAUNCH.md section E rows

| Check | Needs | Substitute that passes now | Passes live when |
| --- | --- | --- | --- |
| Axe WCAG 2.2 A and AA with the real Polaris components and App Bridge | A development store with the app installed (C: Shopify Partner app, dev store) | `app-axe.spec.ts`, 28 tests, against the Polaris shim | The same `AxeBuilder` run over each App Home screen in the embedded admin frame reports zero violations; the run is attached under `docs/evidence/` |
| Live alt text from Claude on real product images | `ANTHROPIC_API_KEY` (C row 5) and a dev store with products | `packages/engine/test/ai/alt-text.test.ts`, 14 job tests with a recorded transport | `test/ai/live.test.ts` runs and a draft appears in the review queue on the dev store |
| Median install-to-first-fix under 10 minutes | 10 design-partner stores, or 3 dev stores for the dry run | `app-journey.spec.ts` (13 s against a fake api; app-side steps only) | The median of `first_fix_at` minus the install time over the installed stores is under 10 minutes (PLAN §5 R1) |
| At least 80% of alt-text drafts approved unedited | The same stores | `edited` is carried on every fix (ADR-093) and the log exports it | Approved without `edited` divided by approved, over the stores' drafts, is at least 0.8 |
| Save bar and `shopify.saveBar` behaviour | Dev store | The page's own Save and Discard buttons, tested | The App Bridge save bar appears on edit and Save and Discard act on the form |
| Managed pricing page link opens in the admin | Dev store with the app listed | The link's address is asserted | The link opens the plan page for the store |
