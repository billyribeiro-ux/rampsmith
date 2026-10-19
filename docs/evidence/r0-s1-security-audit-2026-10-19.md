# Evidence: security audit of lane S1 (R0 gate fixes)

- Date: 19 October 2026
- Auditor: the `security-auditor` subagent, effort max
- Scope: `git diff 6bb8116..f1ec552` (lane S1) and the documentation commits up to `40d86e2` on
  `r0-foundations`: the Shopify token client (no redirects, HTTPS only, error classes), the
  WebAuthn origin check, the live dev-store test that signs an expired ID token with the client
  secret, the `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` rename, and `phosphor-svelte` 3.1.1
- **Verdict: PASS.** No critical, high or medium finding in the lane; seven low findings.
  One medium finding outside the lane (O1) is fixed in the same commit as this file.

## What was checked, and how

- Code read: the diff, ADR-021, 022, 024, 030–033, PLAN §14, §15, §18, §19, and the callers in
  `shopify-auth`, `api`, `ctl` and `telemetry`; library sources of reqwest 0.13.5,
  tracing-subscriber 0.3.23 and SvelteKit 3.1.0.
- `pnpm audit --prod`: no known vulnerabilities, exit 0. `npm view phosphor-svelte@3.1.1`: no
  install scripts; its dependencies were already in the graph; the lockfile integrity matches.
- CI: run 39298334697 (`659999d`) and run 39300708921 (`40d86e2`) green on all 8 checks,
  `cargo-deny` included; the live check's skip notice is annotated on both.
- WebAuthn origin cases replayed over the WHATWG URL parser (40 inputs): userinfo, paths,
  queries, fragments, IP literals, `localhost.` variants, trailing dots, `http` on any host but
  exactly `localhost`, and non-web schemes are refused; production origins are accepted.
- Shopify behaviour checked against Shopify's own npm packages (`@shopify/shopify-api` 15.0.1,
  `@shopify/shopify-app-react-router` 3.0.2), because shopify.dev refused the auditor's proxy.
- No build was run (the sandbox disk was full); CI is the build evidence.

## Answers

- The client secret, refresh tokens and ID tokens go only to
  `https://<a-z0-9->.myshopify.com/admin/oauth/access_token`: `redirect::Policy::none()`,
  `https_only`, and `ShopDomain::parse` admit nothing else.
- Errors carry a status code at most; spans have no fields; `Debug` is redacted.
- A refresh 401 deletes the tokens (never retried); 403, other 4xx and 3xx are never retried;
  429, 5xx and transport errors retry with the shared backoff, at most 8 attempts.
- Only `SHOPIFY_API_KEY` reaches the browser (the only `public: true` variable).
- Audit L3, L9 and L13 are fixed completely; L7 is fixed in `crates/shopify` and the rest is
  lane S2's; L4 is fixed by status code only (F2).

## Findings and where they are fixed

| # | Severity | Finding | Fix | Tracked to |
| --- | --- | --- | --- | --- |
| F1 | low | reqwest logs the shop domain at DEBUG (`connect.rs:929`), forwarded to tracing; the hygiene test filters on `shopify=trace` only, and ADR-032 overstates it | Keep `reqwest`, `hyper_util`, `h2`, `rustls` at `info` unless `RUST_LOG` names them; test; correct ADR-032 | R1 hardening follow-up (Rust) |
| F2 | low | Error classes rest on the status alone: every exchange 400 is "stale ID token"; a refresh 401 from `invalid_client` would delete tokens | Read at most 4 KiB, parse only `{"error"}` into a closed enum, never store or log it; map `invalid_subject_token`, `invalid_client`; probe requires `invalid_subject_token`; amend ADR-032 | R1 hardening follow-up (Rust) |
| F3 | low | `TokenEndpoint::Base` (HTTPS off) ships in production builds; unused there | Compile it only under `cfg(test)` or a test feature, or refuse non-loopback hosts | R1 hardening follow-up (Rust) |
| F4 | low | The live test trims the secret; production does not | Same handling in both configs, with a test | R1 hardening follow-up (Rust) |
| F5 | low | The runbook put the secret in shell history (`export SHOPIFY_API_SECRET=...`) | `read -rs`, then `unset` | **Fixed** in this commit |
| F6 | low | A transient body-read failure on a 2xx is classed as permanent and ends the shop's keep-alive chain | Only `is_decode()` is `Decode`; a leader sweep re-arms missing keep-alives | R1 hardening follow-up (Rust) |
| F7 | low | The rest of L7 (`shopify-auth`, `egress`) still logs domains on `r0-foundations` | Already done on `r1-hardening` (lane S2, PR #15); `r0-gate-fixes.md` now says L7 covered `crates/shopify` only | Lane S2 |
| O1 | medium (outside the lane) | FOUNDER_SETUP told the founder to store `SHOPIFY_API_SECRET` as a GitHub repository secret too, readable by any workflow pushed to a branch, though no workflow uses it | Railway only; a workflow that needs it later gets a GH environment secret on a protected environment | **Fixed** in this commit (`docs/FOUNDER_SETUP.md`) |
