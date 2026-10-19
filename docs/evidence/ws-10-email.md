# WS-10 evidence: email templates (`packages/email`)

Stream WS-10 of the second wave (docs/STATUS.md on `main`), LAUNCH.md B "Onboarding and
transactional email templates, plain-text and HTML, passing `claims-lint`". Branch `ws/email`
from `r0-foundations` at `16926b5`, merged with `r0-foundations` at `4fdfb3b` so the draft
pull request can run `ci.yml`. Draft pull request: #5 (do not merge).

Owned and changed: `packages/email/` (plus the `pnpm-lock.yaml` entries pnpm wrote),
`docs/adr/191` to `194`, this file. Nothing else.

## What was built

`@rampsmith/email`, a pure TypeScript package (no network, no database):

- `createEmailRenderer(settings).render(kind, input)` and `renderUnknown(kind, json)` for 21
  kinds: `sign_in_link` (15-minute single-use link), `email_verification`, `delivery_test`,
  `scanner_confirm` (double opt-in), `scanner_report` (full free-scanner report), `welcome`,
  `first_scan_complete`, `weekly_summary`, `regression_alert`, `barrier_report_received`,
  `fix_approved`, `fix_verified`, `plan_changed`, `usage_limit`, `agency_invitation`,
  `store_link_code`, `store_linked`, `data_deletion`, `uninstall_export`, `incident_notice`,
  `subprocessor_change`.
- Plain text (wrapped at 76 columns, links on their own lines) and HTML (one column, `lang` and
  `dir`, one `h1`, semantic lists and tables, no images or remote resources, 4.5:1 contrast in
  light and dark mode) from one document model.
- All copy in `messages/en.json` (232 messages, inlang message format with plural and
  exact-value variants), with `project.inlang/settings.json`; pseudo-locales prove a new
  language needs only a catalog.
- Footers by category (ADR-191): unsubscribe link plus RFC 8058 headers for notification and
  marketing email, postal address (a founder input, placeholder until set) required in
  marketing email.
- `EmailSender` interface for the later SES adapter, `guardSender` (refuses anything unsafe to
  send), `MemorySender`, `describeForLog`. No SES call.

## Gates (local: Node 26.12.0, pnpm 12.14.0, Ubuntu 24.04)

| Check | Command | Result |
| --- | --- | --- |
| Tests | `pnpm --filter @rampsmith/email test` (with `CI=true GITHUB_ACTIONS=true` as in CI) | 12 files, 780 tests: 779 passed, 1 skipped (the live SES check, LAUNCH.md C row 7) |
| Types | `pnpm run typecheck` | 0 errors in every package |
| ESLint | `pnpm run lint` | 0 problems |
| Prettier | `pnpm run format:check` | clean |
| knip | `pnpm run knip` | clean |
| claims-lint | `node packages/claims-lint/src/main.ts` | 102 files scanned, no banned claims (includes the catalog and the 87 rendered snapshots in `packages/email/test/emails/`) |

Tests per file: `render` 282 (snapshots, structure, links, footers, disclaimer, text and HTML
parity, locale, settings, input errors), `security` 170 (every string field of every email with
14 hostile values, 300 fuzzed names, secret placement, redaction, operator text), `browser`
104 (axe in Chromium 153 for every email in light and dark mode, 320 px reflow, zero network
requests, pseudo-locales `en-XA` and `ar-XB`, four negative controls), `audit` 63 (one or more
per security-audit finding), `schema` 44, `links` 44, `i18n` 25, `sender` 19, `sanitize` 17,
`layout` 9 (contrast ratios of both palettes, wrapping), `claims` 2 (the claims-lint CLI over
the subject, preview, text and HTML of every email, and a negative control), `live` 1.

## CI (pinned toolchains, `ci.yml` on pull request #5)

- Run 39088934342 (`f7581a1`): `rust`, `contracts`, `e2e` and `images` green; `node` failed
  in one test: the claims-lint negative control expected plain output, but the CLI prints
  GitHub annotations when `GITHUB_ACTIONS=true`. Every other email test passed on the runner,
  including the 104 browser tests on `@sparticuz/chromium` in 17.8 s. Fixed by running the CLI
  with `GITHUB_ACTIONS=false` in that test; reproduced and verified locally with
  `GITHUB_ACTIONS=true`.
- Run 39089899615 (`e823c3b`): **all 8 jobs green**: `node` (ESLint, Prettier, tsc and
  svelte-check, knip, claims-lint, Vitest including the 780 email tests), `rust`, `contracts`,
  `e2e`, `images (api)`, `images (web)`, `images (engine)`, `images (egress)`:
  <https://github.com/billyribeiro-ux/rampsmith/actions/runs/39089899615>.
- Run 39089495772 (`62d65e3`) failed only on Prettier for `messages/en.json` (rewritten by a
  script after formatting); fixed in `e823c3b`.

## Security audit (security-auditor brief, effort max)

The `security-auditor` agent type was not available in this session, so a general-purpose
agent ran its brief (`.claude/agents/security-auditor.md` on `main`) at effort max, read-only.

- Round 1 at `f89442d`: PASS, one medium and five lows, plus informational notes. The medium:
  agency and store names chosen by someone else reached subjects of emails sent to people who
  did not ask for them, and a URL in such a name becomes a link (phishing relay). Lows: size
  of names and notices, banned claims split by line breaks or hidden characters, a getter
  could show the guard one recipient and the adapter another, unknown keys echoed in errors,
  and a missing postal address blocking required notices. All fixed in `f7581a1`, each with a
  regression test (`test/audit.test.ts`).
- Round 2 at `f7581a1`: PASS, three lows: link-like names written with hidden or look-alike
  characters, ordinary store names such as "J.Crew" rejected, disguised banned claims in
  operator text. All fixed in `62d65e3` with regression tests.
- `pnpm audit --prod` and `pnpm audit` at the workspace root: no known vulnerabilities (464
  dependencies). `pnpm audit --filter` is not supported by pnpm 12.14.

## ADRs

- ADR-191: what each kind of email must carry (CAN-SPAM, 15 U.S.C. 7702(17), 16 CFR 316.3,
  GDPR, ePrivacy Art. 13, ICO, CASL, Google and Yahoo sender rules, RFC 8058), with sources
  and dates. **Attorney review required** for the category mapping.
- ADR-192: package design, catalogs, HTML and text rendering, dependencies, tests.
- ADR-193: input validation, escaping, links, secrets, names other people choose.
- ADR-194: the sending boundary, `email.send` in the Node engine, the live check, Chromium in CI.

## For the integrator

Shared files this stream did not edit:

1. **PLAN corrections** are in each ADR's "Plan correction" section: PLAN §6, §8 layout and
   catalogs, §10 (`email.send` moves to the engine), §16, §19, §24.
2. **LAUNCH.md C row 7**: add `EMAIL_POSTAL_ADDRESS` and the optional `EMAIL_TEST_RECIPIENT`
   (ADR-191). **Row 13**: add the ADR-191 category mapping to the attorney's list.
3. **LAUNCH.md E**, new row: "Test email delivered through Amazon SES | 7 | `pnpm --filter
   @rampsmith/email test` (render, guard and MemorySender suites) | with row 7 set:
   `pnpm --filter @rampsmith/email exec vitest run test/live.test.ts`". Today the live test
   skips with "needs LAUNCH.md section C row 7 (SES_REGION, SES_ACCESS_KEY_ID,
   SES_SECRET_ACCESS_KEY, EMAIL_FROM)"; with row 7 set and no adapter wired in it fails on
   purpose (ADR-194, step 3).
4. **`docs/adr/README.md`**: add ADR-191 to ADR-194.
5. **`rsctl doctor`** (WS-6) can send the `delivery_test` email as its SES probe and should
   check that `EMAIL_POSTAL_ADDRESS` is set.
6. **App work** (ADR-193, ADR-194): single-use links answered by a page that POSTs, never
   consumed on GET; the one-click unsubscribe endpoint and preferences page; suppressions
   checked before rendering; the SES adapter behind `guardSender`; `email.send` payload
   `{ kind, input }` in `crates/contracts`; agency-name rules matching `displayName`.
7. **Browser tests**: they run in `ci.yml`'s `node` job through `@sparticuz/chromium`. If the
   integrator prefers Playwright's own Chromium, run the email tests after the `e2e` job's
   `playwright-core install` step; the launcher picks it up automatically.

## Outside this stream's paths

- `packages/claims-lint`: its `lawsuit-proof` rule allows only spaces and ASCII hyphens between
  the words (`[\s-]*`), so "lawsuit‑proof" with a non-breaking hyphen or an en dash passes the
  repository-wide check. `packages/email` scans operator text in a skeleton form that maps every
  Unicode dash to "-", so emails are covered; the CI check over catalogs, listing copy and pages
  is not. Proposed patch for the main builder: in `packages/claims-lint/src/rules.ts`, use
  `[\s\p{Pd}]*` in the `lawsuit-proof` pattern and add a test for U+2011 and U+2013.
- When the stream started, `apps/web/tests/mock-api.ts` was reported unused by knip until
  `web:sync` ran; CI runs `web:sync` first, so it does not fail there.

## Founder decisions raised

- ADR-191's category mapping (which emails carry an unsubscribe link and the postal address)
  is a legal reading: attorney review before launch.
- Whether an agency invitation to someone without an account should carry a "do not email me
  again" link (ADR-191, consequences).
