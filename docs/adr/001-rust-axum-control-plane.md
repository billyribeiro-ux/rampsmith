# ADR-001: Rust and Axum for the control plane

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

The control plane (`api`, `ctl`, `rsctl`) holds the money and authentication paths: Shopify session tokens and token exchange, envelope-encrypted offline tokens, billing state and the fix-approval workflow. Those paths need the strongest compile-time guarantees available, and the founder's primary stack is Rust.

## Decision

Write `api`, `ctl` and `rsctl` in Rust (edition 2024) on Axum 0.8 and Tokio. Each service is one small release binary. Pure logic lives in library crates under `crates/`; binaries only wire them together.

## Consequences

- Strict types end to end, `unsafe` forbidden workspace-wide, and Clippy denies `unwrap`, `expect` and `panic` outside tests.
- Two languages in one repository: contracts between them are generated, never hand-written (ADR-009).
- Axum 0.8.9 was the current release on crates.io on 17 Oct 2026 (see `docs/evidence/`).

## Rejected alternatives

- Node for everything: weaker guarantees on the money and auth paths.
