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

## M2 telemetry URLs (ADR-053)

What changed: `UrlRedactingSpanProcessor` (`packages/telemetry/src/redact.ts`) runs first in
`startTelemetry`'s processor list, which the engine and `apps/web/src/instrumentation.server.ts`
both call. It reduces URL attributes to origin plus path, rewrites URLs and `*.myshopify.com`
names inside any other string, event or link attribute, and replaces secret-named attributes.
`startTelemetry` now builds the OTLP exporter itself (`@opentelemetry/exporter-trace-otlp-proto`
0.223.0, added with `pnpm add -E`; `@opentelemetry/sdk-trace-base` 2.12.0 moves to runtime
dependencies) so that nothing can be exported ahead of the redactor.

Before the fix, on the built web app exporting to a local collector (`app.spec.ts`, test "exported
telemetry carries no launch parameter, token or shop name"): the OTLP body held
`https://127.0.0.1:41071/app?embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com` and the
test failed with `Expected substring: not "id_token"`. After: the body holds the route, the
`sveltekit.handle.root` span and `://127.0.0.1:<port>/app`, and none of `id_token`, `hmac`,
`session`, `myshopify`, `embedded=1`; the test passes (8 of 8 in the `embedded` project).

Unit tests (`packages/telemetry/test/redact.test.ts`, 21 tests, 24 in the package): URL and text
rewriting, 200,000 characters of hostile input, every attribute shape, late attributes, events and
links, `startTelemetry`, and the real OTLP pipeline into a local collector searched byte for byte.
Removing the processor from `startTelemetry` fails two of them (`expected
'http://localhost:3000/app?embedded=1&…' to be 'http://localhost:3000/app'` and `id_token:
expected '\n\u009c…' not to contain 'id_token'`).

## M3 content security policy (ADR-054)

What changed: `apps/web/src/lib/server/headers-policy.ts` holds the directives and
`vite.config.ts` passes them to SvelteKit. `script-src` is `'self'`,
`https://cdn.shopify.com/shopifycloud/` and SvelteKit's nonce (before: the whole host);
`default-src 'self'` and explicit `style-src`, `img-src`, `font-src` and `connect-src` are new;
`object-src`, `base-uri`, `form-action` and the per-shop `frame-ancestors` are unchanged.
`style-src` keeps `'unsafe-inline'` for Polaris' shadow-root styles, the one loosening, reasoned
in the ADR.

Built app, real Chromium (`app.spec.ts`, 10 of 10 in the `embedded` project;
`dashboard.spec.ts`, 4 of 4 in the `dashboard` project):

- The header of `/`, `/nope` and `/app?shop=...` equals the policy written out in
  `tests/csp.ts`, with one nonce each; the sign-in page carries the same policy.
- The embedded page loads (with stand-ins for the two Shopify scripts), starts its session and
  passes axe, and the dashboard registers, signs out and signs in with a passkey, all with zero
  `Content Security Policy` console errors.
- A script from `/shopifycloud/later-chunk.js` runs. Scripts from `/s/files/...`,
  `/shopifycloud-evil/`, `/static/fonts/` and `evil.example` are refused before the network
  (`request.failure()` names the policy; the console reports `script-src`; none ran), and so is
  an inline script without the nonce.
- With the old `script-src 'self' https://cdn.shopify.com` rebuilt in, both new embedded tests
  fail (the header differs; the three non-Shopify-script addresses on the CDN host ran).

Not proven here: the real App Bridge and Polaris scripts under this policy (`cdn.shopify.com` is
unreachable from the sandbox). ADR-054 lists what to read in the browser console on the first
development-store load, and which directive to widen, narrowly, if a violation shows.

## L8 session cookie and caching, `web` half (ADR-055)

What changed: the dashboard session cookie is `__Host-rs_session` (always `Secure`, `HttpOnly`,
`SameSite=Lax`, `Path=/`, no `Domain`); `finishCeremony` lost its `secure` argument; the new
`clearSession` deletes it with the same attributes and is used by sign-out and by the dashboard
layout. `securityHeaders` adds `cache-control: private, no-store` to every `/dashboard` response.

Chromium accepts the cookie on `http://localhost`: in `tests/dashboard.spec.ts` (dashboard
project, real api, `http://localhost:3996`, 5 of 5) the cookie is in the browser after
registering with `secure: true`, `path: '/'`, `httpOnly: true`, `sameSite: 'Lax'`; the
`Set-Cookie` header has no `Domain`; and the next request is signed in.

Negative proofs: with `clearSession` reduced to `cookies.delete(name, { path: '/' })` (what
SvelteKit would send on localhost, `Secure` off), two tests fail with the cookie still in the
browser after sign-out and after the api ended the session (`Received: {"name":
"__Host-rs_session", "secure": true, ...}`). With the `cache-control` line removed, two
`headers.test.ts` tests fail. Unit totals: `dashboard.test.ts` 12, `headers.test.ts` 6, web 37.

Not in this change (Rust lane): revoking earlier sessions on sign-in and redacting
`SessionCreated`'s `Debug`.
