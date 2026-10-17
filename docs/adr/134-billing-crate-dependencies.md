# ADR-134: Dependencies of the billing crate

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-4 (`crates/billing`)

## Context

PLAN §8 requires an ADR line for every new runtime dependency, and CLAUDE.md requires each
version and license to be read from the live registry. `deny.toml` denies new duplicate
versions and licenses outside its allowlist.

## Decision

`crates/billing` uses only crates already in `[workspace.dependencies]`, plus one new
development dependency. Versions and licenses were read from `https://crates.io/api/v1/crates/<name>`
on 2026-10-17 (`docs/evidence/ws-4-billing.md` holds the output).

| Crate | Version | License | Kind | Why |
| --- | --- | --- | --- | --- |
| `thiserror` | 2.0.21 (workspace) | MIT OR Apache-2.0 | normal | Typed errors (PLAN §8) |
| `time` | 0.3.55 (workspace) | MIT OR Apache-2.0 | normal | UTC instants, calendar-month windows, RFC 3339 parsing of Partner API `DateTime` values; features `parsing`, plus `macros` in tests |
| `serde` | 1.0.229 (workspace) | MIT OR Apache-2.0 | normal | Deserializing the Partner API response |
| `serde_json` | 1.0.154 (workspace) | MIT OR Apache-2.0 | normal | The GraphQL request body and response envelope |
| `secrecy` | 0.10.3 (workspace) | Apache-2.0 OR MIT | normal | The Partner API token never reaches `Debug`, errors or logs |
| `proptest` | 1.12.0 (new; MSRV 1.88) | MIT OR Apache-2.0 | dev | Property tests that a higher plan never gives less (PLAN §7 pins 1.12.0, PLAN §23) |

`proptest` is declared in `crates/billing/Cargo.toml` with `default-features = false,
features = ["std"]`, which leaves out the `fork`, `timeout` and `bit-set` features and so
`rusty-fork`, `tempfile`, `bit-set` and `bit-vec`. It reuses the workspace's `rand` 0.10.3, so
no duplicate version appears. Its new transitive crates are `rand_xorshift` 0.5.0
(MIT OR Apache-2.0), `unarray` 0.1.4 (MIT OR Apache-2.0) and `core_detect` 1.0.0
(MIT/Apache-2.0); `cargo deny --locked check` passes with them.

At integration, move `proptest` to `[workspace.dependencies]` (the comment in the manifest
says so).

## Consequences

- No async runtime is a dependency: the Partner API transport trait returns a future, and the
  crate's tests drive it with `std::task::Waker::noop` (stable since Rust 1.85).
- No HTTP client is a dependency: the `api`/`ctl` binaries implement the transport with
  `reqwest` (PLAN §7) when they wire billing in.

## Rejected alternatives

- `graphql_client` (PLAN §14) for the Partner API: it targets the Admin API schema; the Partner
  API needs one query, whose document is a constant checked by tests against the documented
  shape. Revisit if the crate grows several Partner API operations.
- `tokio` as a dev-dependency only to run one always-ready future: unnecessary weight.
- `rust_decimal` for Shopify's `Decimal` scalar: an exact digit-by-digit parser into minor
  units is a few lines and avoids a new dependency.
