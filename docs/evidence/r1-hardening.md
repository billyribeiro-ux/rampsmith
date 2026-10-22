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

## Test execution status of the sections below (read this first)

The sections M6, L1, L14, L7 (egress), L6, L8, L12 and the `jobs` isolation work below were
written after the shared volume ran out of space: `df` showed 0 to 90 MB free for the last
several hours, and `ld` dies with SIGBUS when a test binary cannot be written (the api, ctl and
db test binaries are 140 to 220 MB each). I did not delete anything from the shared target
directory (the classifier refused a first attempt, and the brief forbids it), so those tests were
**compiled and linted but not run**:

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` | clean (all test targets compiled) |
| `cargo sqlx prepare --workspace --check -- --all-targets --all-features --locked` | passes against the migrated dev database (migrations 20261101000001 and 000002 applied) |
| `cargo machete` | no unused dependencies |
| `cargo deny --locked check` | advisories ok, bans ok, licenses ok, sources ok |
| `cargo test --workspace --all-features --locked --test envelope` (crypto) | 17 passed, 0 failed, including the new `rewrap_carries_the_data_over_and_refuses_tampered_data` |
| egress `token` integration test | run once before its last edit: 5 passed, 1 failed (`signing_round_trips_and_is_bound_to_the_key` used `exp = now + 1000`, which the new horizon refuses); the test now uses `exp = now + 100` and was **not** re-run |

Everything else needs a run on a machine with space. The command, from the repository root with
the database URL set as at the top of this file, is
`cargo nextest run --workspace --all-features --locked`; the test names to look for are listed
per finding. I desk-checked every new assertion against the code and the SQL (the GCRA
arithmetic, the row-lock ordering in the simultaneous sign-in test, the row-level-security error
texts, the IPv6 vectors against the policy constants), but a desk check is not evidence.

## M6: passkey `start` rate limits and the sweep (ADR-042)

What changed: `crates/api/src/rate_limit.rs` (generic cell rate algorithm, per client and global,
`StartAllowed` extractor in front of the body extractor on both `start` handlers, 429
`application/problem+json` with `Retry-After`, client address from the last `X-Forwarded-For`
entry, IPv6 keyed by /64, no peer fallback, tracked clients capped at 4,096); migration
`20261101000001_identity_sweep.sql` (`identity_sweep()`, security definer, executable by
`rampsmith_worker` only); `db::repo::identity::sweep`; `ctl::leader::sweep_identity` and
`Cadence::sweep_every` (ten minutes) in the leader loop.

Tests (written, compiled, not run): `api` unit tests in `rate_limit.rs` (11: GCRA arithmetic,
burst and refill, refusal takes nothing, no-address counts globally, table cap, /64 and mapped
IPv4 keying, `Retry-After` rounding); `api::auth` six tests (429 with `Retry-After` and no row
stored; one budget for both endpoints; spoofed earlier `X-Forwarded-For` entries buy nothing;
global limit including unaddressed requests; refusal before the body is read; `finish` and
session routes unaffected); `db::identity::the_worker_sweeps_expired_sign_in_state_and_only_that`,
`the_application_role_cannot_run_the_sweep` and `the_worker_role_cannot_read_identity`; `ctl::a_sweep_removes_only_expired_sign_in_state`
and `the_leader_sweeps_on_its_own_cadence`.

For the architect:

- The web BFF must send the address it verified as the **last** `X-Forwarded-For` entry on both
  start calls, and the api must stay unreachable except from the BFF (ADR-042 section 2). Until
  then every request counts against the global budget only.
- The limits are constants in `StartLimits::default()` because `crates/api/src/config.rs` is
  outside my lane. Making them settings is a follow-up for whoever owns that file.
- The OpenAPI document is unchanged. Adding a 429 response to the two `start` operations would
  change `packages/contracts-ts/openapi/api.json` and `src/generated/api.ts`; I left that to you.
- New migrations mean the database must be migrated before the api and ctl are ready; the
  readiness check already enforces this (`expected_schema_version`).

## L1, L14, L7 (egress): IPv6 default-deny, token horizon, no host in spans (ADR-043)

What changed: `crates/egress/src/policy.rs` (IPv6 allowed only inside `2000::/3`, minus
`2001::/23`, `2001:db8::/32`, `2002::/16`, `3fff::/20`; IPv4-mapped and NAT64 still judged by the
embedded IPv4 address), `crates/egress/src/token.rs` (`MAX_TOKEN_AHEAD_SECS = 300`; `verify`
refuses `exp > now + 300`, saturating), `crates/egress/src/proxy.rs` (the `server.address` span
field is gone), `crates/egress/testdata/tokens.json` (vectors recomputed independently with
Python HMAC so the valid ones sit inside the horizon; a distant-`exp` vector added to the invalid
set).

Tests (written, compiled, not run unless noted): `policy`:
`ipv6_outside_global_unicast_is_refused`, `exceptions_open_ipv6_ranges_outside_global_unicast_too`,
two new proptests (every address outside `2000::/3`, except the two embedded-IPv4 forms, is
refused; every address in `3fff::/20` is refused). `token`: `a_token_that_expires_too_far_ahead_is_refused`
(exactly +300 accepted, +301 refused, `i64::MAX` refused, no overflow) and the shared vectors
(this file ran once: 5 passed, 1 failed on a stale `exp`, now fixed). `proxy`:
`a_token_that_expires_too_far_ahead_must_authenticate_again` (407, then a fresh token gets 200)
and `spans_and_logs_never_contain_the_merchants_host` (a capturing `tracing` subscriber; an
allowed tunnel, an allowed HTTP request and three refusals; the span name, `scan="test-scan"` and
the outcome are present and none of `shop.test`, `other.test`, `private.test` appears).

For the architect:

- `packages/engine/test/pure.test.ts` reads the regenerated `tokens.json`. It should pass
  unchanged (the TypeScript signer uses `exp = now + 120`), but S3 should re-run it.
- `exp` is now bounded in the Rust verifier only. If the engine ever signs tokens longer than
  five minutes it must lower `MAX_TOKEN_AHEAD_SECS` in step (ADR-043).

## L6: master-key re-wrap job (ADR-045, amends ADR-021)

What changed: `KeyRing::rewrap` documentation now states what it does (the data ciphertext is kept
byte for byte; the value is decrypted once and dropped, to prove the context); migration
`20261101000002_token_rewrap.sql` (`shopify_tokens_to_rewrap`, `shopify_token_key_counts`, security
definer, worker only); `Db::tokens_to_rewrap`, `Db::token_key_counts`;
`db::repo::shopify::replace_wrapping` (compare-and-swap on version, key id and both ciphertexts,
version not bumped); `ctl::rewrap::{Rewrap, Report}` (batched, keyset-paged, idempotent, safe to
run concurrently); `shopify_auth::{access_context, refresh_context}` made public.

Tests: `crypto::rewrap_carries_the_data_over_and_refuses_tampered_data` (**ran: passes**). Written,
compiled, not run: `db::repos` four tests (`replacing_the_wrapping_changes_the_key_and_keeps_the_version`,
`..._loses_to_any_change_since_the_read` including the delete-and-store-again ABA case,
`the_worker_lists_token_rows_under_other_keys_across_tenants`,
`only_the_worker_may_list_tokens_to_rewrap`); `ctl` three populated-database tests (five shops in
five tenants installed through real token exchange under key k1; a batch-of-two pass moves all to
k2 with versions unchanged and the value ciphertext tail identical, every token opens with a
ring that holds only k2; a second pass writes nothing; two passes at once re-wrap each row once;
an unknown key and a damaged ciphertext are reported as `failed` and left untouched).

For the architect: the interface for W1's `rsctl` is in ADR-045 section 4
(`ctl::rewrap::Rewrap::new(db, keys).run()` and `.remaining()`); I did not create the operator
command. ADR-021 decision 4 and PLAN §14 step 5 need the corrections listed in ADR-045.

## L8 (Rust parts): session responses are not printable; sign-in ends earlier sessions (ADR-046)

What changed: `SessionCreated` and `UserInfo` have hand-written `Debug` (token `[redacted]`, user
shown by id only) in `crates/api/src/auth.rs`; `Identity::create_session` calls the new
`db::repo::identity::delete_sessions_of` (row lock on the user, then delete) before it inserts the
new session, in the same transaction, for both sign-in and registration.

Tests (written, compiled, not run): `api` unit test
`debug_output_never_shows_the_session_token_or_the_person`;
`identity::signing_in_ends_that_users_earlier_sessions_and_nobody_elses` (a failed sign-in ends
nothing; two later sign-ins leave Ada one session; Bob's survives; one row per user) and the
updated `register_then_sign_in_with_the_same_passkey` (the registration session stops working
after the sign-in); `db::identity::ending_a_users_sessions_leaves_every_other_user_alone` and
`simultaneous_sign_ins_of_one_user_take_turns` (the second sign-in provably waits for the first,
then ends its session).

For the architect: the `__Host-` cookie prefix and `cache-control: private, no-store` parts of L8
are in `apps/web` (S3). One active session per user is a product consequence (ADR-046): signing in
on a phone signs out the laptop. Say so if you want a cap instead.

## L12: a failed leader check abandons the connection (ADR-047)

What changed: `ctl::leader::keep_or_drop` runs the liveness query and, on failure, detaches the
connection from the pool and closes it (five-second bound), so the advisory lock goes with the
session; the leader loop uses it.

Tests (written, compiled, not run): `ctl::a_failed_liveness_check_closes_the_leader_connection_and_frees_the_lock`
(the leader's session is poisoned with an aborted transaction so that it stays open and keeps the
lock; a second pool, standing for another instance, cannot lead until `keep_or_drop` has run and
then can; with the old behaviour the connection returns to the pool still holding the lock and
the assertion fails) and `a_healthy_leader_connection_keeps_its_lock`.

For the architect: none.

## Isolation suite: `jobs` (ADR-047)

What changed: `crates/db/tests/tenancy.rs`: `jobs` is in `TENANT_TABLES` (12 tables); the suite
seeds one job per tenant and one system job (no tenant); the foreign-row query uses `is distinct
from` so a tenant-less row counts as foreign; two new tests
(`jobs_are_seen_by_their_tenant_and_by_workers_only`,
`the_app_role_enqueues_only_for_its_own_tenant_and_never_edits_jobs`).

Tests: written, compiled, not run.

For the architect: none.
