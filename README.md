# Rampsmith

Accessibility fixed at the source. Rampsmith is a self-serve Shopify app that finds WCAG 2.2 AA
failures, fixes them in the store's own data and theme code, and keeps a dated remediation record.

- Build plan: [`docs/PLAN.md`](docs/PLAN.md)
- Instructions for Claude Code sessions: [`CLAUDE.md`](CLAUDE.md)
- Architecture decision records: [`docs/adr/`](docs/adr/)
- Version evidence: [`docs/evidence/`](docs/evidence/)

## Repository layout

One repository holds a Cargo workspace (`crates/`) and a pnpm workspace (`apps/`, `packages/`)
side by side, as laid out in PLAN §8.

| Path | What lives there |
| --- | --- |
| `crates/domain` | Pure domain types: no I/O, no async, no database |
| `crates/contracts` | Types that cross a language boundary, with generated JSON Schema |
| `packages/tsconfig` | Shared strict TypeScript configurations |
| `packages/contracts-ts` | Generated TypeScript types and schemas; never hand-edited |
| `packages/claims-lint` | Fails the build on banned claims (PLAN §3) |
| `docs/adr` | One file per architecture decision |

## Toolchain

[mise](https://mise.jdx.dev) installs everything except Rust; rustup reads `rust-toolchain.toml`.

| Tool | Version | Pinned in |
| --- | --- | --- |
| Rust | 1.99.1, edition 2024 | `rust-toolchain.toml` |
| Node.js | 26.12.0 | `.mise.toml`, `package.json` `engines` |
| pnpm | 12.14.0 | `.mise.toml`, `package.json` `packageManager` (never Corepack) |
| PostgreSQL | 18.6 | `.mise.toml` |
| cargo-binstall, cargo-nextest, cargo-deny, cargo-machete, sqlx-cli | see `.mise.toml` | `.mise.toml` |

```sh
mise install          # Node, pnpm, PostgreSQL and the cargo tools
mise run setup        # pnpm install --frozen-lockfile
mise run verify       # the full gate; must pass before every commit
```

`mise run verify` runs every static check (rustfmt, Clippy with `-D warnings`, cargo-deny,
cargo-machete, ESLint with zero warnings, Prettier, `tsc`, knip) and then every test suite. It
mirrors the pull-request gate in `.github/workflows/ci.yml` (PLAN §24). `mise tasks` lists each
step so one can be run on its own, for example `mise run check:clippy`.
