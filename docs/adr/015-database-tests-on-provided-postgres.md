# ADR-015: Database tests run on a provided PostgreSQL, not testcontainers

- Status: Accepted
- Date: 2026-10-17
- Amends: PLAN §7 (test crates) and §23 (Rust data layer row)

## Context

PLAN §7 lists `testcontainers` 0.28 for the Rust data-layer tests, while §24 already runs
`cargo nextest` against a PostgreSQL 18 service container. Using both means two PostgreSQL
servers per CI run, a Docker socket in every environment that runs tests, and an image pull
per run. The Claude Code sandbox cannot pull images at all (ADR-014).

The data-layer tests need: the real PostgreSQL 18 engine, migrations applied, isolation
between tests, and real commits (LISTEN/NOTIFY, lease expiry, concurrent claims), which
rules out wrapping each test in a rolled-back transaction.

## Decision

Rust tests that need a database use `#[sqlx::test]` against the server named by
`DATABASE_URL`. Each test receives a fresh database with the workspace migrations applied,
and it is dropped afterwards.

- CI: the `postgres:18.6-bookworm` service container, pinned by digest, in `ci.yml`.
- Local: the mise-managed PostgreSQL 18.6.
- `testcontainers` is removed from the planned stack.

Because superusers and table owners bypass row-level security, tests that exercise
tenancy connect through the non-owner application role, exactly as production does
(ADR-006).

## Consequences

- No Docker dependency for any test; one PostgreSQL per CI job.
- The `DATABASE_URL` role in CI and local development must be allowed to create
  databases. Production roles never are.
- The engine's TypeScript queue tests follow the same pattern: one database per test file,
  created from `DATABASE_URL`.

## Rejected alternatives

- `testcontainers`: duplicates the CI service container and needs Docker everywhere.
- One shared database with per-test rollback: cannot test commits, notifications or
  concurrent workers.
