# Evidence: R1 hardening, TypeScript lane (S3)

- Date: 19 October 2026
- Branch: `r1-hardening-ts`, from `r0-foundations` at `6bb8116`
- Source: `docs/evidence/r0-security-audit-2026-10-19.md` findings M1, M2, M3, M4 (engine part), L2,
  L8 (web parts), L10, L15
- Environment: Node 26.12.0, pnpm 12.14.0, PostgreSQL 18.4 (`rampsmith_s3`), Chromium
  153.0.8010.0 (`@sparticuz/chromium` 153.0.0 at `/tmp/chromium`, launched by Playwright 1.64.1
  with Playwright's own default arguments, not `chromium.args`), `egress` and `api` debug builds
  from `r0-foundations`.

## M1 WebRTC bypass and L2 loopback (ADR-050)

What changed: `packages/engine/src/browser.ts` (new) owns the launch options and the per-context
proxy settings; `main.ts`, `self-check.ts` and the browser tests launch through it. Chromium gets
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; the launch proxy and every context
proxy carry `bypass: '<-loopback>'`; the engine and `scanPage` refuse to run when
`PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is defined. The `loopback` test option is
gone (loopback always goes through egress).

Tests (written first, `packages/engine/test/`):

- `webrtc.e2e.ts`: a page runs two peer connections, one with `stun:127.0.0.1:<port>` and one with
  a remote candidate `127.0.0.1:<port>`, each port a `node:dgram` listener; the page is scanned
  through the real `egress` binary.
- `loopback.e2e.ts`: with the override variable set, a context with the engine's proxy settings
  still stops at egress (403, the site served 0 requests); a context without the explicit entry
  reaches the site directly (200, 1 request served), which is the audit finding.
- `browser.test.ts` (14 unit tests): the launch arguments, the explicit bypass, the refusal.

Measured, same test, same Chromium (datagrams that reached the listeners):

| Launch | `stun:` server listener | remote-candidate listener |
| --- | --- | --- |
| Without the policy (`args: []`, the old settings) | 5 | 72 and 74 on two runs |
| Engine settings (`launchBrowser`) | 0 | 0 |

With the argument removed from `launchOptions`, `webrtc.e2e.ts` fails
(`expected [ …(5) ] to have a length of +0 but got 5`); restored, it passes. The switch exists in
the browser binary: `strings /tmp/chromium | grep force-webrtc-ip-handling-policy` and
`grep disable_non_proxied_udp` both match.

Deploy-time restriction: Railway's documentation lists no outbound filter, so ADR-050 records
what holds in code and what stays for the founder.

## L10 stored selectors and final URL (ADR-051)

What changed: `packages/engine/src/scrub.ts` gains `scrubSelector` and `scrubUrl` (and a linear
email scan that replaces the pattern in `scrubExcerpt`); `recordPage` scrubs `target`,
`html_excerpt` and `page_url` before any statement and fingerprints the scrubbed selector.

Tests written first (`test/scrub.test.ts`, 35 tests, `test/store-scrub.test.ts`, 3 tests against
PostgreSQL): attribute values in single, double and no quotes, `]` and escaped quotes inside
values, unterminated selectors, CSS-escaped email ids, frame-crossing `>>>` selectors,
credentials, query string, fragment, `%40` and plain emails in the path, UUID and hex and
mixed-case tokens, `data:` and `javascript:` addresses, NUL bytes, and 200,000-character
hostile inputs. The store test writes four hostile occurrences with a hostile address and then
reads `row_to_json(finding_occurrences)` back: none of nine planted secrets (an email, an
`id_token`, a card number, a reset key, a fragment, a password) is in the row.

Before the fix the three store tests failed (`expected [ …(4) ] to deeply equal [ '#[email] > img',
… ]`, two findings instead of one, and `invalid byte sequence for encoding "UTF8": 0x00`); the
last shows a hostile page could also make `recordPage` fail for the whole job. The first draft of
the email pattern backtracked: the hostile-input test took 15.7 s over inputs cut to 4096
characters and failed its 1.5 s bound; the email scan now looks outward from each `@` and the same
test runs in milliseconds.

## M4 engine role guard (ADR-052)

What changed: `packages/engine/src/role-guard.ts` (`checkWorkerRole`, `assertWorkerRole`) runs in
`main.ts` before Chromium and the worker start. The engine exits with code 1 and a message that
names the role and every reason, unless `current_user` and `session_user` are neither superuser
nor `BYPASSRLS`, the role owns no relation in `public`, and it is a member of `rampsmith_worker`
that inherits the privileges. No flag disables it. The engine's test helper `test/db.ts` now
logs in as throw-away `LOGIN` roles `IN ROLE rampsmith_worker` / `rampsmith_app` (created per test
database and dropped with it) instead of switching role in a superuser session.

Tests, against PostgreSQL 18.4 (`role-guard.test.ts`, 11 tests; `main.test.ts`, 3 tests that start
the real `main.ts` as a child process): passing member; member through another role; the
migration owner; a created superuser; `BYPASSRLS`; a table owner, a sequence owner and a view
owner; a non-member; a `NOINHERIT` member; a superuser session after `SET ROLE
rampsmith_worker`; all reasons reported together with no password in the message; a missing
group role. After the runs `pg_roles` holds 0 `rs_t_*` roles and `pg_database` 0 `rs_engine_*`
databases.

All 25 pre-existing engine unit tests, the store tests and the 12 browser tests pass as a member
role, which also exercises row-level security as the deployed engine will (the cross-tenant test
in `store.test.ts` is unchanged and still passes).
