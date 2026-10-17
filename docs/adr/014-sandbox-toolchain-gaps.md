# ADR-014: Local verification toolchain when pinned downloads are blocked

- Status: Accepted
- Date: 2026-10-17
- Applies to: Claude Code cloud sessions only; CI and developer machines use the pins

## Context

The pinned toolchain (PLAN §7) was re-checked on 17 Oct 2026:

| Tool | Pin | Evidence |
| --- | --- | --- |
| Rust | 1.99.1 | blog.rust-lang.org/releases lists "Announcing Rust 1.99.1" on Oct 15 |
| Node.js | 26.12.0 | npm `node-linux-x64` publishes 26.12.0 on 2026-10-15 |
| pnpm | 12.14.0 | `npm view pnpm version` → 12.14.0 |
| PostgreSQL | 18.6 | postgresql.org/support/versioning lists 18.6 as the current 18.x minor |
| mise | 2026.10.12 | `npm view @jdxcode/mise version` → 2026.10.12 |

The Claude Code cloud sandbox reaches the npm registry, crates.io and GitHub over git,
but its egress allowlist rejects `static.rust-lang.org`, `nodejs.org`, `mise.jdx.dev`,
`ftp.postgresql.org`, `apt.postgresql.org`, Docker Hub and `ghcr.io` (proxy answers 403
to CONNECT). So `rustup` cannot install 1.99.1, mise cannot download Node or PostgreSQL,
and no container image can be pulled.

## Decision

Keep every pin unchanged in `.mise.toml`, `rust-toolchain.toml`, `package.json` and CI.
For verification inside the sandbox only, use the closest toolchain that can be obtained:

| Tool | Pinned | Used in the sandbox | Gap |
| --- | --- | --- | --- |
| Rust | 1.99.1 | 1.97.0 (preinstalled), selected with `RUSTUP_TOOLCHAIN=stable` | Two minor releases older. Every crate in §7 declares `rust-version` ≤ 1.94.1, so all build; Clippy may differ by lints added in 1.98–1.99. CI runs 1.99.1. |
| Node.js | 26.12.0 | 26.12.0, the official binary repackaged on npm as `node-linux-x64@26.12.0`, registered with `mise link` | None in version; provenance differs (npm mirror, not nodejs.org). |
| pnpm | 12.14.0 | 12.14.0 from `@pnpm/exe.linux-x64`, registered with `mise link` | None. |
| mise | 2026.10.12 | 2026.10.12 from `@jdxcode/mise-linux-x64` | None. |
| PostgreSQL | 18.6 | 18.4 from `@embedded-postgres/linux-x64@18.4.0-beta.17` | Two patch releases older; same major, so catalog, RLS and SQL behaviour match. CI runs 18.6. |
| Container images | digests | none | Tests use a provided PostgreSQL instead of `testcontainers` (ADR-015). |

The sandbox exports `MISE_OFFLINE=1` and `MISE_DISABLE_TOOLS=postgres,cargo-binstall` so mise
does not try to download what it cannot reach; the cargo tools are built with `cargo install`
at their pinned versions and registered with `mise link`.

## Consequences

- A green local gate in the sandbox is strong evidence but not proof for Rust 1.99.1 and
  PostgreSQL 18.6; the CI gate on GitHub Actions is the authority.
- Lints introduced after Rust 1.97 can only surface in CI, so a red Clippy step in CI after
  a green local run is expected to be investigated, never suppressed.
- Nothing about this sandbox leaks into committed configuration.
