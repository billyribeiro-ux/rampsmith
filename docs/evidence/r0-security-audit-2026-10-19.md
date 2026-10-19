# Evidence: R0 security audit

- Date: 19 October 2026
- Auditor: the `security-auditor` subagent (`.claude/agents/security-auditor.md`), effort max
- Scope: `r0-foundations` at `af3f48c` (`c3673f6` plus this evidence folder's Node record):
  `crates/crypto`, `crates/shopify`, `crates/shopify-auth`, `crates/db`, `crates/identity`,
  `crates/api`, `crates/egress`, `crates/ctl`, `packages/engine`, `apps/web`, secrets handling,
  dependencies, images
- **Verdict: PASS** (no critical or high findings). Six medium and fifteen low findings follow;
  each is tracked to a fix below. Nothing was edited by the auditor.

## Commands the auditor ran

| Command | Result |
| --- | --- |
| `cargo deny --locked check` (cargo-deny 0.20.2) | advisories, bans, licenses, sources ok; exit 0; no ignored advisories |
| `pnpm audit --prod` (pnpm 12.14.0) | no known vulnerabilities; exit 0 |
| `cargo nextest run -p rampsmith-db` (Rust 1.97, PostgreSQL 18.4) | 43 of 43 passed, the isolation suite included |
| RLS probe on a throw-away migrated database | every tenant table has RLS enabled (not forced); a member of `rampsmith_app` fails closed without a tenant; a non-superuser table owner reads every tenant (see M4) |
| `crates/egress/src/policy.rs` compiled unchanged in a scratch crate against IPv6 edge cases | see L1 |
| Chromium 153 with Playwright 1.64.1 and the engine's production proxy settings | WebRTC sent 4 UDP packets to 127.0.0.1 outside the proxy (M1); with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, 0; loopback, `localhost` and `169.254.169.254` navigations went through egress; WebTransport refused to run through a proxy |

Limits: shopify.dev answers 403 through this sandbox's proxy, so Shopify behaviour was checked
against `docs/spikes/S-4-initial-document-token.md` and Shopify's own npm packages
(`@shopify/shopify-api` 15.0.1, `@shopify/shopify-app-react-router` 3.0.2); the sandbox has no
IPv6 route.

## What holds

- Envelope encryption: AES-256-GCM, a fresh data key and random nonce per value, key id and slot
  context authenticated, rotation tested at library level; secrets in `secrecy`/`zeroize` with
  redacted `Debug`.
- Shopify session tokens: HS256 only; `aud`, `exp`, `nbf` with 5 s leeway; `dest` must be a
  `*.myshopify.com` origin and match `iss`; failures answer 401 with the retry header.
- Token exchange sends `expiring=1` and the offline token type; refresh rotation is a tested
  compare-and-swap; no token in logs, errors, `Debug` or problem+json bodies.
- Tenancy: `TenantTx` everywhere; application roles are `NOLOGIN`, own nothing, no `BYPASSRLS`;
  composite tenant foreign keys hold.
- Egress resolves DNS itself, checks every answer, dials only checked addresses; IPv4 lists,
  IPv4-mapped and NAT64 handling complete; redirects and CONNECT re-checked, CONNECT limited to
  443; scan tokens verified in constant time.
- Images run non-root, pinned by digest; the Chromium sandbox is on with Playwright's seccomp
  profile.
- Web: per-shop `frame-ancestors`, nonce CSP (apart from M3), HSTS, `HttpOnly`/`Secure`/
  `SameSite=Lax` cookies, SvelteKit's origin check; the browser never calls `api`.
- No committed secrets; CI actions pinned by SHA with `read-all` permissions.

## Findings and their fixes

Medium findings are fixed before R1 work builds on the affected code, on branch
`r1-hardening` (see `docs/STATUS.md`); low findings are fixed there too unless marked.

| # | Severity | Finding | Where | Fix |
| --- | --- | --- | --- | --- |
| M1 | medium | A scanned page can send UDP (WebRTC STUN/TURN/DTLS) that bypasses egress, to any address including loopback and metadata ranges | `packages/engine/src/main.ts:26`, `scan-page.ts:134-152` | Launch Chromium with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (engine and self-check); e2e test with a UDP listener and an `RTCPeerConnection`; ADR for deploy-time network restriction of the engine |
| M2 | medium | Web telemetry exports the full request URL, including Shopify's `id_token`, `hmac`, `session` and `shop` launch parameters | `apps/web/vite.config.ts:17`, `instrumentation.server.ts:6-9`, `packages/telemetry/src/index.ts:32-53` | Span processor that rewrites `http.url` to origin plus path; test that no exported attribute carries those parameters |
| M3 | medium | `script-src` allows all of `https://cdn.shopify.com`, which serves merchant-uploaded files | `apps/web/vite.config.ts:23` | Narrow to `https://cdn.shopify.com/shopifycloud/`; add `default-src 'self'` and explicit `connect-src`, `img-src`, `style-src` |
| M4 | medium | Isolation depends on the runtime login not being a superuser or table owner, and nothing checks it | migration `20261017000002_core_tables.sql:258-280`; `crates/db/src/tx.rs:27-33`; `crates/ctl/src/main.rs`; `packages/engine/src/main.ts`; `crates/api/src/health.rs:56` | Startup and `/readyz` refuse to serve unless `current_user` is not super, not `BYPASSRLS`, owns nothing in `public`, and is a member of `rampsmith_app` (api) or `rampsmith_worker` (ctl, engine); document the LOGIN roles and a separate migration owner |
| M5 | medium | The per-shop advisory lock waits without a timeout while holding a pool connection and needs a second one, so concurrent cold opens can exhaust the api pool for every tenant | `crates/db/src/tx.rs:93-102`, `crates/shopify-auth/src/lib.rs:189-206`, `crates/api/src/config.rs:73` | In-process single-flight per shop; `SET LOCAL lock_timeout`; re-check and store on the lock's own connection; concurrency test with a small pool |
| M6 | medium | Unauthenticated passkey `start` endpoints insert rows with no rate limit, and expired ceremonies and sessions are never swept | `crates/api/src/auth.rs:152,205`, `crates/identity/src/lib.rs:153`, `crates/db/src/repo/identity.rs:342` | Per-IP and global rate limits on `start`; `identity::sweep` scheduled by the ctl leader; tests |
| L1 | low | Egress allows IPv4-compatible `::/96`, `::ffff:0:0:0/96`, `3fff::/20`, `5f00::/16` | `crates/egress/src/policy.rs:12-70` | Refuse IPv6 outside `2000::/3` (keeping mapped and NAT64 handling) and `3fff::/20`; add the cases to `tests/policy.rs` |
| L2 | low | Loopback goes through egress only because of a Playwright default | `scan-page.ts:148` | Pass `bypass: '<-loopback>'` explicitly; refuse to start if `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set; correct the comment |
| L3 | low | The token client follows redirects and would resend `client_secret` | `crates/shopify/src/token.rs:148-153` | `redirect(Policy::none())`, `https_only(true)` for Shopify |
| L4 | low | Only 401 on refresh is treated as revoked | `crates/shopify/src/token.rs:249` | Classify by the OAuth `error` code; confirm on shopify.dev when reachable |
| L5 | low | Exchange writes are an unconditional upsert, not the compare-and-swap ADR-022 states | `crates/db/src/repo/shopify.rs:164-195` | Make it a compare-and-swap or amend ADR-022 |
| L6 | low | Key rotation has no rewrap job; a keyring doc comment is wrong | `crates/crypto/src/keyring.rs:143`, `envelope.rs:252-264` | Rewrap job with a populated-database test (W1's `rsctl` owns the operator side); correct the comment |
| L7 | low | Shop domains in logs and spans (PLAN §19 says ids only) | `shopify-auth/src/lib.rs:207,355,372`, `shopify/src/token.rs:166,186`, `egress/src/proxy.rs:338` | Log tenant and shop ids |
| L8 | low | Session hardening | `apps/web/src/lib/server/dashboard.ts:10,116`, `crates/api/src/auth.rs:87` | `__Host-` cookie prefix; revoke earlier sessions on sign-in; redact `SessionCreated` `Debug`; `cache-control: private, no-store` on dashboard pages |
| L9 | low | `WEBAUTHN_RP_ORIGIN` check accepts `http://localhost.<rp_id>` | `crates/api/src/config.rs:100` | Parse as a URL; allow `http` only for the exact host `localhost` |
| L10 | low | axe target selectors and the final URL are stored unscrubbed | `scan-page.ts:123`, `store.ts:96` | Scrub attribute values and query strings |
| L11 | low | The engine shares `rampsmith_worker` with ctl | roles migration | A narrower engine role |
| L12 | low | A failed leader liveness query returns a connection that still holds the session lock | `crates/ctl/src/leader.rs:186-193` | Detach or close the connection |
| L13 | low | Code reads `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`; LAUNCH.md row 1 and FOUNDER_SETUP say `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` | `crates/api/src/config.rs`, LAUNCH.md | Align the names |
| L14 | low | Egress accepts any future `exp` on a scan token | `crates/egress` | Refuse `exp > now + 300` |
| L15 | low | No `minimumReleaseAge` in `pnpm-workspace.yaml` (PLAN §18) | `pnpm-workspace.yaml` | Add it |

Not applicable in R0: webhooks (no endpoint exists yet; they are audited when they land);
identity tables carry no RLS by ADR-024; egress budgets connections by design (ADR-025 §4).
Functional note: stores whose primary domain is custom fail scans today because the scan token
lists only the `*.myshopify.com` host; R1's scan scheduler must add the primary domain.
