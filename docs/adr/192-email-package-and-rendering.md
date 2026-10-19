# ADR-192: `packages/email`: typed templates, message catalogs, plain text and accessible HTML

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-10 (LAUNCH.md B)

## Context

LAUNCH.md B needs "onboarding and transactional email templates, plain-text and HTML, passing
`claims-lint`". PLAN §3 bans compliance claims in email; PLAN §8 puts all UI strings in
Paraglide JS message catalogs; PLAN §16 and §19 name the sign-in link, the free scanner's
double opt-in and report, the uninstall export link, incident notices and subprocessor
notices; PLAN §5 adds weekly rescans, regression alerts and agency linking. This stream owns
only `packages/email/`: it cannot edit root configuration (ESLint, Prettier, knip ignore
lists), `ci.yml` or other packages.

## Decision

1. **API.** `createEmailRenderer(settings)` returns `render(kind, input)` (typed per kind) and
   `renderUnknown(kind, json)` (for queue payloads). Settings are the app origin, the site
   origin, the support address and the postal address (ADR-191); they are validated once, at
   startup. A render returns a frozen `RenderedEmail` (subject, preview text, plain text, HTML,
   headers, category, language, and any `problems` that block sending).
2. **21 kinds**: `sign_in_link`, `email_verification`, `delivery_test`, `scanner_confirm`,
   `scanner_report`, `welcome`, `first_scan_complete`, `weekly_summary`, `regression_alert`,
   `barrier_report_received`, `fix_approved`, `fix_verified`, `plan_changed`, `usage_limit`,
   `agency_invitation`, `store_link_code`, `store_linked`, `data_deletion`,
   `uninstall_export`, `incident_notice`, `subprocessor_change`. Limits shown in plan emails
   are inputs from `crates/billing`'s entitlements function, never restated here.
3. **Templates build a document, renderers write it.** Each template returns blocks
   (paragraph, heading, list, label-value facts, action button, one-time code, note, operator
   prose). One HTML renderer and one plain-text renderer read the same document, so both
   versions always say the same thing and escaping lives in one place.
4. **Message catalogs.** All copy is in `messages/en.json`, in the inlang message format that
   `apps/web` uses with Paraglide (`project.inlang/settings.json` points the same plugin at it,
   pinned at 4.5.4), so translators and inlang tooling work on both. The package formats the
   subset it uses itself (`{name}` placeholders, escapes, plural and exact-value variants via
   `Intl.PluralRules`) instead of running Paraglide's compiler, because: the compiled output is
   generated code that the root ESLint, Prettier and knip configurations (not owned by this
   stream) would check; Paraglide's runtime keeps a global locale suited to a page request,
   while a worker renders many recipients' languages in one process; and the formatter rejects
   any syntax it does not support when a catalog loads, so a catalog never formats differently
   from Paraglide. Adding a language is one `messages/<tag>.json`, one entry in
   `project.inlang/settings.json` and one import in `src/translator.ts`; a test keeps the three
   in step. Dates and numbers use the recipient's regional tag (`en-GB`) and time zone.
5. **HTML.** One column, `lang` and `dir` on `<html>` and on a `role="article"
   aria-roledescription="email"` wrapper (mail clients drop `<html>`), one `<h1>`, `<h2>`
   sections, lists, data tables with row headers, text wordmark instead of a logo. No images,
   no remote fonts, styles or scripts: the email reads the same with images off and makes no
   network request. Text contrast is at least 4.5:1 in light mode and in dark mode
   (`prefers-color-scheme`, `color-scheme` meta), the button is 3:1 against the card and keeps
   a border for forced colours, links are underlined, standalone links are at least 24 px tall
   (WCAG 2.5.8), and inputs are wrapped in `<bdi>` so right-to-left names do not reorder a
   sentence. An Outlook conditional table centres the column.
6. **Plain text** wraps at 76 columns on spaces and puts every link on its own line, so no
   client breaks a link.
7. **Dependencies** (npm registry, read 2026-10-17): runtime `@rampsmith/claims-lint`
   (workspace; its `scanText` checks operator text, ADR-193). Development only:
   `vitest` 5.0.5 (MIT), `playwright-core` 1.64.1 (Apache-2.0), `axe-core` 4.14.0 (MPL-2.0,
   unmodified), `@sparticuz/chromium` 153.0.0 (MIT; Chromium 153; engines
   `^22.17.0 || >=24.0.0`; no install script), `@rampsmith/tsconfig`. None has peer ranges this
   workspace violates, and none needs `allowBuilds`.
8. **Tests**: snapshots of every email (HTML, text, subject, preview and headers) under
   `test/emails/`, which the repository's `claims-lint` glob `**/emails/**/*` also scans in CI;
   the claims-lint CLI run over every rendered output, with a negative control; structural
   checks that only the renderer's own tags and attributes appear; axe-core in Chromium for
   every email in light and dark mode with the WCAG 2.0, 2.1 and 2.2 A and AA rules plus best
   practices, 320 px reflow, no network requests, pseudo-locales for 40% longer text and
   right-to-left layout, and negative controls proving the harness catches failures. Two
   best-practice rules are off, `region` and `landmark-one-main`: an email body is shown inside
   the mail client's own page, which owns the landmarks.

## Consequences

- A worker renders any email from a JSON payload with one call, and an invalid payload fails
  with a field path before anything is sent.
- Copy changes are catalog edits that the snapshot tests show in review.
- The package does not use Paraglide's compiler; if the web app's messages and the emails
  should share one inlang project later, the formatter can be replaced by compiled messages
  without changing templates (they call `t.text` and `t.rich`).

## Plan correction

- PLAN §8 layout: add `packages/email/  # every email as plain text and HTML, with catalogs
  (ADR-192)` under `packages/`.
- PLAN §8 "TypeScript and Svelte standards", catalogs bullet: "Email copy lives in inlang
  message-format catalogs in `packages/email/messages/`, formatted by the package (ADR-192)."
- PLAN §24, step 3 (`claims-lint`): "email templates" are the catalogs in
  `packages/email/messages/` and the rendered snapshots in `packages/email/test/emails/`.

## Rejected alternatives

- MJML or a React email library: a build step and a dependency tree to produce markup this
  package writes in about 400 lines, with less control over accessibility.
- Paraglide's compiler in this package: see decision 4.
- Images (logo, icons): they fail with images off, cost a network request and are a tracking
  vector.
