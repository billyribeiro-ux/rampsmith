# ADR-039: R1 dependencies, checked on the live registry

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-038; CLAUDE.md "Evidence rules"

## Context

R1 needs a Shopify Admin GraphQL client in Rust (PLAN §14) and an image resizer in the engine
(PLAN §13). CLAUDE.md requires every dependency's current version, license and peer range to
be read from the registry at the time it is added, never taken from memory or from PLAN.

## Decision

Checked on 22 October 2026 against crates.io and the npm registry:

| Dependency | Version | Evidence | Used by |
| --- | --- | --- | --- |
| `graphql_client` (crates.io) | 0.16.0 | Newest stable (`max_stable_version` 0.16.0), published 2026-01-15, `Apache-2.0 OR MIT`, `rust_version` 1.66.0; unchanged from `docs/evidence/versions-2026-10-17.md` | `crates/shopify-admin` (lane A) |
| `sharp` (npm) | 0.35.5 | `npm view sharp version` prints 0.35.5, modified 2026-09-27, `engines.node` `>=20.9.0`, so Node 26 is inside the range; unchanged from the 17 October evidence | the engine, for vision-call image resizing (lane C) |

1. `graphql_client` joins `[workspace.dependencies]` with `default-features = false`: the
   derive and the response types, without the reqwest and CLI features. The crate that uses it,
   `rampsmith-shopify-admin`, is a workspace member now, as the manifest comment requires
   ("add a crate here only when a member uses it"). `cargo-deny` and `cargo-machete` pass on it.
2. `sharp` is not added by Phase 0 (ADR-038, last consequence). Lane C adds it at exactly
   0.35.5 with `pnpm add`, checks its install-script policy in `pnpm-workspace.yaml`, and
   re-verifies the version on the registry that day.
3. A later lane that needs another dependency checks the registry the same way and records the
   result in its own ADR.

## Consequences

- Lane A can write Admin API operations without touching the workspace manifest.
- `Cargo.lock` changes only through `cargo`.

## Rejected alternatives

- A hand-written GraphQL client over `reqwest`: PLAN §14 chooses generated types checked
  against Shopify's schema so a renamed field fails the build.
