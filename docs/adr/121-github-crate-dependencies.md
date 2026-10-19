# ADR-121: GitHub crate dependencies: aws-lc-rs and reqwest instead of jsonwebtoken and octocrab

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

PLAN §7 pins `jsonwebtoken` 11.1.0 for "Shopify session tokens (HS256) and GitHub App JWTs
(RS256)" and `octocrab` 0.54.5 for the GitHub App API, and §23 names `wiremock` for faking
integrations. `deny.toml` denies new duplicate versions and licenses outside its allowlist, and
the stream brief asks to prefer crates already in `Cargo.lock`.

Checked on crates.io on 2026-10-17 (`docs/evidence/ws-3-github-app.md` has the raw output):

- `jsonwebtoken` 11.1.0 needs a crypto backend feature. Its PEM support (`use_pem`) adds `pem`
  and `simple_asn1`; its `rust_crypto` backend adds the `rsa` crate, whose Marvin timing
  advisory (RUSTSEC-2023-0071) has no patched version in the advisory database cargo-deny
  fetched on 2026-10-17, so `cargo deny check` would fail. Its `aws_lc_rs`
  backend still adds `jsonwebtoken` and `signature` 2.x, and still leaves PEM parsing to us.
- `octocrab` 0.54.5 brings its own HTTP stack, JWT handling and token cache. Its cache and
  error types are outside our control, so the properties this stream must prove (no token in
  `Debug`, errors or spans; tokens never serialized; no redirects; bounded responses) would
  depend on another project's internals.
- Rampsmith only ever *signs* App JWTs. The risky part of a JWT library is verification
  (algorithm confusion, claim checks), which this crate never does. RS256 signing is a
  base64url header and claims plus an RSA PKCS#1 v1.5 SHA-256 signature.

## Decision

`crates/github` uses only crates already in `Cargo.lock`, at the exact locked version, each
declared in `crates/github/Cargo.toml` with `# move to [workspace.dependencies] at integration`:

| Crate | Version | License (crates.io) | Why |
| --- | --- | --- | --- |
| `aws-lc-rs` | 1.18.2 | ISC AND (Apache-2.0 OR ISC) | RS256 signing with `RsaKeyPair` (PKCS#1 and PKCS#8). Already the process's rustls provider (ADR-019). Default features off: they add `untrusted` 0.7, a duplicate. |
| `base64` | 0.23.1 | MIT OR Apache-2.0 | PEM bodies, base64url JWT parts, base64 blob uploads. Same version `r0-foundations` adds to the workspace. |
| `hmac` | 0.13.0 | MIT OR Apache-2.0 | Webhook HMAC with constant-time `verify_slice` (PLAN §7 pin). |
| `sha2` | 0.11.1 | MIT OR Apache-2.0 | SHA-256 for the HMAC (PLAN §7 pin). Default features off: `oid` adds `const-oid`. |
| `http` | 1.5.0 | MIT OR Apache-2.0 | `HeaderMap` for webhook headers, the type Axum hands the `api` route. |
| `reqwest` | 0.13.5 | MIT OR Apache-2.0 | Async HTTPS client, `rustls` feature only (aws-lc-rs provider, platform verifier), the same build the OTLP exporter already compiles. |
| `url` | 2.5.8 | MIT OR Apache-2.0 | Base URL validation, query encoding, evidence links. |
| `proptest` (dev) | 1.12.0 | MIT OR Apache-2.0 | Webhook property tests; same version `r0-foundations` adds to the workspace. |

Workspace dependencies reused: `opentelemetry`, `secrecy` (no new features), `serde`,
`serde_json`, `thiserror`, `time` (adds the `formatting` and `parsing` features), `tokio` (adds
`sync`; tests add `macros`, `net`, `rt`, `time`), `tracing`; dev: `axum`, `tracing-subscriber`.

The only new crates in `Cargo.lock` are `rampsmith-github` and proptest's own dev tree, which
resolves to the same versions `r0-foundations` already locked. HTTP fakes are a loopback Axum
server in `crates/github/tests/support`, not `wiremock`.

## Consequences

- No new advisory or license surface; `cargo deny --locked check` and `cargo machete` pass.
- The JWT code is about 40 lines and is tested against an independent verifier (the fake
  server checks the RS256 signature with the public key and the claims as GitHub would).
- If the main builder adds `jsonwebtoken` for Shopify HS256 session tokens, nothing here
  conflicts; the GitHub crate does not need it.
- At integration the architect moves these entries to `[workspace.dependencies]`.

## Plan correction

PLAN §7, "Control plane" table — replace the `jsonwebtoken` row's purpose and the `octocrab` row:

```
| `jsonwebtoken` | 11.1.0 | Shopify session tokens (HS256). GitHub App JWTs (RS256) are signed with `aws-lc-rs` in `crates/github` (ADR-121) |
| `aws-lc-rs` | 1.18.2 | RS256 signing of GitHub App JWTs; already the rustls provider (ADR-019, ADR-121) |
```

Delete the row `| \`octocrab\` | 0.54.5 | GitHub App API |`; the GitHub REST calls use `reqwest`
0.13.5 (rustls) in `crates/github` (ADR-121, ADR-125).

PLAN §23, "By component", row "Rust integrations" — replace the Tools cell `wiremock` with:

```
`wiremock`, or a loopback Axum fake where the crate already depends on Axum (`crates/github/tests/support`, ADR-121)
```

## Rejected alternatives

- `jsonwebtoken` with `aws_lc_rs` and `use_pem`: three new crates for a signing step we can
  test directly, and its key types' `Debug` and zeroization are outside our control.
- `octocrab`: a second token cache and error model to audit, and its redirect and logging
  behaviour would have to be proven safe rather than set.
- RustCrypto `rsa`: open timing advisory, and a second RSA implementation in the process.
