# R1 hardening: builder S2 (Rust security findings)

Branch `r1-hardening`, from `origin/r0-foundations` at 6bb8116. Findings are those of
`docs/evidence/r0-security-audit-2026-10-19.md`. Toolchain: rustc 1.97.0 (the pinned 1.99.1 cannot
be downloaded in this environment; the gates run on `stable`, see "For the architect"). Database:
PostgreSQL 18.4 at 127.0.0.1:5432. Every command ran from the repository root with
`SQLX_OFFLINE=false DATABASE_URL=postgres://...@127.0.0.1:5432/rampsmith_s2` unless it says
otherwise.

## M4: runtime role guard (ADR-040)

What changed: `crates/db/src/roles.rs` (`Db::verify_runtime_role`), called at `api` startup and in
every `/readyz`, and at `ctl` startup. It refuses a superuser, `BYPASSRLS`, a role that owns
relations or is a member of `pg_database_owner`, a role that can create in `public`, a login
that is not a member of its group role or does not inherit it, a `SET ROLE` session started by a
superuser, and (for the api) a login that is also a worker. No switch disables it. Every api and
ctl test now connects through a `LOGIN` member of the group role, like a deployment.

Commands and results:

- `cargo nextest run -p rampsmith-db --test roles`: 13 tests, 13 passed (one per refusal above,
  plus the two accepted logins, plus an unreachable database not being a refusal).
- `cargo nextest run -p rampsmith-api --test http`: `readiness_refuses_a_superuser_connection` and
  `readiness_refuses_a_superuser_that_switched_to_the_application_role` pass, next to the
  existing readiness tests (schema version, behind-migrations, unreachable database).
- `cargo nextest run -p rampsmith-ctl --test ctl`: 4 startup tests pass
  (`startup_accepts_a_login_member_of_rampsmith_worker`, `startup_refuses_a_superuser_at_once`,
  `startup_refuses_a_superuser_that_switched_to_the_worker_role`,
  `startup_waits_for_an_unreachable_database_and_stops_on_shutdown`).

For the architect:

- `DATABASE_URL` and the migration owner's URL are now different values everywhere. Deploy
  pipeline, `mise` migrate tasks, CI service containers, runbooks and FOUNDER_SETUP must say so;
  ADR-040 has the operator SQL for the two logins. `infra/smoke/api.sh` still passes because the
  api tolerates an unreachable database at startup.
- The engine (S3) runs the same query from `packages/engine`; the SQL is in `roles.rs`.
- PLAN §9 and §22 corrections are in ADR-040 "Plan correction".

## M5: per-shop token lock (ADR-041)

What changed: `crates/db/src/flights.rs` (in-process single flight per shop, capped at half the
pool), `crates/db/src/tx.rs` (`Db::shop_lock` with `lock_timeout`, `ShopLock::shop_by_domain`,
`ShopLock::into_tenant`, `DbError::LockTimeout`), `crates/shopify-auth/src/lib.rs`
(`authenticate_at` and the refresh path run on the lock's one connection and commit once),
`crates/api/src/shopify.rs` (lock timeout answers 503 `unavailable`).

Commands and results:

- `cargo nextest run -p rampsmith-db -p rampsmith-shopify-auth --all-features --locked`:
  `Summary 81 tests run: 81 passed, 0 skipped`. New: `db::shop_lock` 5 tests, `db::flights`
  3 unit tests, `shopify-auth::lifecycle` three contention tests
  (`a_burst_of_cold_opens_on_a_small_pool_completes`, `a_slow_cold_open_does_not_slow_other_tenants`,
  `a_lock_held_by_another_process_ends_the_wait_with_an_error`).
- `cargo nextest run -p rampsmith-api --test shopify_session`: 8 passed, including the new
  `a_shop_locked_by_another_process_answers_503_after_a_bounded_wait`.
- `cargo nextest run -p rampsmith-ctl`: 15 passed (the refresh job runs on the new path).
- Reproduction: with the in-process queue switched off,
  `a_burst_of_cold_opens_on_a_small_pool_completes` (pool of 3, 20 simultaneous first opens of
  2 shops) fails; with it, it passes.
- L7 (shopify-auth part): the three log lines that named the shop domain now carry `shop_id`.
  `#[instrument]` on `refresh_if_due` records only ids and the time; `authenticate_at` skips all
  arguments; no error `Display` in `shopify-auth` or `shopify` includes the domain.

For the architect: the sqlx offline data gained `set_config('lock_timeout', ...)` and replaced
the `app_shop_by_domain` lookup (same statement, moved into a helper, so its text hash changed).

## L5: exchange writes are compare-and-swap (ADR-044, amends ADR-022)

What changed: `db::repo::shopify::put_tokens` takes the caller's read (`None` or `Some(version)`)
and returns `None` when the row moved; `shopify-auth` reads the row under the lock before the
exchange and fails with a conflict if it changed during the call.

Commands and results:

- `cargo nextest run -p rampsmith-db -p rampsmith-shopify-auth --all-features --locked`:
  `Summary 84 tests run: 84 passed, 0 skipped`. New: `db::repos::exchange_writes_are_compare_and_swap`,
  `db::repos::concurrent_exchange_writes_from_the_same_read_have_one_winner` (also the insert
  race), `shopify-auth::lifecycle::an_exchange_does_not_overwrite_a_row_changed_while_it_was_in_flight`.
  `db::tenancy` now asserts that neither claim overwrites another tenant's row.

For the architect: none.
