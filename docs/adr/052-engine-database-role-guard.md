# ADR-052: The engine refuses an unsafe database login

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-006 (shared schema, row-level security), ADR-025 (engine skeleton)
- Fixes: R0 security audit M4, engine part (`api` and `ctl` are ADR-040s, lane S2)

## Context

Row-level security is enabled on every tenant table, and the migrations create two `NOLOGIN`
group roles, `rampsmith_app` and `rampsmith_worker`, that own nothing and have no `BYPASSRLS`.
The policies do not apply to a superuser, to a role with `BYPASSRLS`, or to a table's owner (the
tables have RLS enabled but not forced). The migrations' comment says "the application never
connects as the owner", and nothing checks it. The audit's probe showed a non-superuser table
owner reading every tenant. If the engine's `DATABASE_URL` pointed at the migration owner (on
Railway, the database's default `postgres` user is both superuser and owner), every query would
still succeed, `SET app.tenant_id` would still run, and isolation would be gone without a sign.

## Decision

1. **A startup check, `packages/engine/src/role-guard.ts`.** Before it launches Chromium or claims
   a job, `main.ts` runs `assertWorkerRole`. The engine exits with code 1 and one message on
   stderr (naming the role and every reason, never a password or the connection string) unless
   the connected role:
   - is not a superuser, and has no `BYPASSRLS`: checked for `current_user`, the role row-level
     security looks at, and for `session_user`, the role that logged in, because a superuser
     session that ran `SET ROLE rampsmith_worker` (or whose URL carries `options=-c role=…`)
     is subject to policies only until it switches back;
   - owns no relation in schema `public` (tables, partitions, indexes, sequences, views and
     the rest of `pg_class`);
   - is a member of `rampsmith_worker` whose privileges it inherits
     (`pg_has_role(current_user, 'rampsmith_worker', 'usage')`), directly or through another
     role. A `NOINHERIT` member would pass a membership test and then fail on its first query.
2. **No switch.** There is no environment variable, argument or build flag that skips or
   weakens the check. A deployment that cannot satisfy it is misconfigured.
3. **Tests use the production shape.** The engine's test helper (`test/db.ts`) now creates a
   throw-away `LOGIN` role per test database, `IN ROLE rampsmith_worker` (or `rampsmith_app`),
   and connects as it, instead of switching role inside the superuser's session. The guard's
   tests (`role-guard.test.ts`, against the real PostgreSQL) create a passing role, a role that
   is a member through another role, a superuser, a `BYPASSRLS` role, owners of a table, a
   sequence and a view, a non-member, a `NOINHERIT` member and a superuser session that switched
   role, and drop them afterwards. `main.test.ts` starts the real `main.ts` against a superuser
   URL, a non-member and a table owner and checks the exit code and message.
4. **What the deployment needs.** Migrations run as the database owner (the pre-deploy command).
   The engine's `DATABASE_URL` names a separate login created once by the owner:
   `CREATE ROLE rampsmith_engine LOGIN PASSWORD '…' IN ROLE rampsmith_worker;` (the same shape
   for `ctl` and, with `rampsmith_app`, for `api`). The password is a Railway variable the
   founder sets. Rows for this belong in LAUNCH.md section E until a live deploy has run the
   engine against Railway's PostgreSQL.

## Consequences

- A wrong `DATABASE_URL` stops the engine at start instead of silently reading across tenants.
  The check runs once; a role changed while the engine runs is not noticed until a restart.
- L11 (a narrower engine role than `rampsmith_worker`, which `ctl` shares) stays open and
  deferred to the R1 lanes as before; the guard checks the group role only because that is the
  role the migrations create today. When a narrower `rampsmith_engine_group` exists, the name is
  one constant (`WORKER_ROLE`).
- The queue package's own test helper still switches role inside a superuser session; it is
  outside the guard's path and outside this lane.

## Rejected alternatives

- Checking `current_user` only: passes a superuser session that did `SET ROLE`, which can undo
  it. The extra check costs nothing and matches how a mistake would look.
- `ALTER TABLE … FORCE ROW LEVEL SECURITY` as the only defence: subjects owners to policies but
  not superusers or `BYPASSRLS` roles, and the migration owner needs to bypass policies to move
  data. It complements the guard (S2's lane) and does not replace it.
- A warning in the log: nobody reads logs at the moment isolation fails.
