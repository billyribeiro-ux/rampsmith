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
