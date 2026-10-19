# ADR-016: Pull-request gate mechanics

- Status: Accepted
- Date: 2026-10-17
- Refines: PLAN §24

## Context

PLAN §24 lists seven required stages for `ci.yml`. R0 step 2 builds the gate before any
deployable exists, and some stages depend on accounts that cost money.

## Decision

1. **One definition of each check.** `ci.yml` jobs (`rust`, `node`, `contracts`) call the
   same `mise run check:*` and `test:*` tasks that `mise run verify` runs locally, so the
   local gate and CI cannot drift apart.
2. **Pinning.** Every action is pinned to a full commit SHA with its tag in a comment
   (`actions/checkout` v7.0.1, `jdx/mise-action` v5.2.0, `Swatinem/rust-cache` v2.9.2,
   `actions/cache` v6.1.0); SHAs were read with `git ls-remote` on 2026-10-17. The
   PostgreSQL service image is pinned by index digest. mise itself is pinned to 2026.10.12,
   and `jdx/mise-action` verifies the download against mise's signed release manifest.
   Runners are pinned to `ubuntu-24.04`, never `ubuntu-latest`.
3. **Least privilege.** `permissions: read-all` at the top; each job asks for
   `contents: read` only; checkout does not persist credentials.
4. **Contract drift.** `check:contracts` regenerates JSON Schemas and TypeScript types into a
   temporary directory and runs `diff -ru` against the committed files. Unlike
   `git diff --exit-code`, this works the same with uncommitted changes locally.
5. **Prettier scope.** Prettier checks code, configuration and data. Markdown is excluded:
   the plan and ADRs are prose, and Prettier's table padding would rewrite every table on
   each edit.
6. **claims-lint exceptions** are explicit and self-cleaning: an inline
   `claims-lint-allow <rule>: <reason>` marker, or an entry in `claims-lint.allow.json` for
   formats without comments. Missing reasons, unknown rules and unused exceptions fail.
7. **Deferred stages.** Stage 6 (images, CycloneDX SBOM, vulnerability gate) is added with
   the first Dockerfile (R0 step 6). Stage 7 (Railway preview environment with end-to-end,
   accessibility and performance suites) needs a Railway project and deploy token, which is
   a spending decision for the founder (PLAN §27).

## Consequences

- Branch protection for `main` (required checks `rust`, `node`, `contracts`; linear history;
  squash merges) is a repository setting the founder applies; the job names are stable.
- `renovate.json` is committed; installing the Renovate GitHub App is the founder's call.
- The first CI run on a cold cache installs the cargo tools from prebuilt binaries via
  cargo-binstall; later runs restore them from the mise cache.

## Rejected alternatives

- Running `mise run verify` as one CI job: simpler, but one red check would hide the others
  and the log would interleave parallel tasks.
- `git diff --exit-code` for contract drift: fails locally whenever generated files are
  modified but not yet committed.
