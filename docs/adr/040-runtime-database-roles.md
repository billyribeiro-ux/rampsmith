# ADR-040: Runtime database roles and the startup guard

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-006 (shared schema, enforced twice)
- Source: R0 security audit finding M4 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

Row-level security isolates tenants only for a role that cannot bypass it. The R0 migrations
create two `NOLOGIN` group roles, `rampsmith_app` and `rampsmith_worker`, that own nothing and
have no `BYPASSRLS`, and they enable (not force) row-level security on every tenant table. A
superuser, a role with `BYPASSRLS` and the owner of a table all read every tenant. Nothing
stopped a service from being deployed with the migration owner's URL as `DATABASE_URL`, which
works perfectly and silently turns the second isolation layer off. The audit rated it medium
because it needs a deployment mistake, and the mistake is easy to make: the local development
URL, CI's service container and the migration step all use the owner.

## Decision

1. **Three database identities.**
   - The **migration owner** owns the tables and runs `sqlx migrate run`. Its URL is
     `DATABASE_MIGRATE_URL`, held by the deploy's migration step only. No service receives it.
   - `rampsmith_app_login` is a `LOGIN` member of `rampsmith_app`: the `api` service.
   - `rampsmith_worker_login` is a `LOGIN` member of `rampsmith_worker`: `ctl` and the engine.
     (A narrower engine role is audit finding L11, deferred.)
   The services' `DATABASE_URL` is the login's URL. The logins are not created by a migration:
   they carry passwords, which never enter the repository.

2. **The guard.** `db::Db::verify_runtime_role(RuntimeRole)` asks the database who the pool is
   connected as and refuses unless every one of these holds:
   - `current_user` is not a superuser and has no `BYPASSRLS`;
   - if `SET ROLE` is in use, the session's login (`session_user`) is neither, because a
     superuser can `RESET ROLE`;
   - `current_user` owns no relation outside the system schemas, and is not a member of
     `pg_database_owner` (the owner of the database owns the `public` schema and can drop any
     table in it);
   - `current_user` cannot create objects in `public`;
   - `current_user` is a member of the service's group role **and inherits its privileges**
     (`pg_has_role(.., 'usage')`, so `NOINHERIT` fails);
   - for the api, `current_user` is not also a member of `rampsmith_worker`: permissive
     policies combine with OR, so the worker policy on `jobs` (`using (true)`) would show the api
     every tenant's jobs.
   The error lists every violation and names the role (a role name is not a secret); a failed
   check never reveals more to a caller than "the database role is not an application role".

3. **Where it runs.**
   - `api` checks at startup and in **every** `/readyz`. At startup a violation ends the
     process with the reasons. A database that is unreachable at that moment cannot be asked,
     so startup logs a warning and continues; `/readyz` answers 503 until the check passes, and
     PLAN §22 switches traffic only after `/readyz` does.
   - `ctl` checks at startup, before the leader loop and the workers start. It retries while
     the database is unreachable (so a deploy that starts first does not crash-loop) and stops
     on a violation, since no retry fixes a wrong URL.
   - The engine runs the same query from `packages/engine/src/main.ts` (S3's lane; the SQL is
     in `crates/db/src/roles.rs`).
   There is **no setting, environment variable or build flag that disables the guard.** Tests
   connect through real `LOGIN` roles, exactly like a deployment (`crates/*/tests/support`).

4. **Operator SQL.** Run once per database, as the migration owner, after the first migration
   (the group roles come from migration 1). Passwords come from a generator
   (`openssl rand -base64 32`) and go straight into Railway variables:

   ```sql
   create role rampsmith_app_login    login password '<generated>' in role rampsmith_app;
   create role rampsmith_worker_login login password '<generated>' in role rampsmith_worker;
   -- Optional, per service: cap the connections one login may hold.
   alter role rampsmith_app_login    connection limit 40;
   alter role rampsmith_worker_login connection limit 40;
   ```

   Rotating a password is `alter role rampsmith_app_login password '<new>'` followed by a
   redeploy with the new variable. Local development: run the same two statements against the
   development database with throw-away passwords, point `DATABASE_MIGRATE_URL` (and the
   `mise` migrate tasks) at the owner, and point `DATABASE_URL` at the login when running a
   service.

## Consequences

- A deployment with the owner's URL fails loudly at its health check instead of serving
  every tenant to every request.
- `DATABASE_URL` and the migration owner's URL are now different values everywhere: deploy
  pipeline, local development, runbooks and FOUNDER_SETUP must say so (see the evidence file's
  "For the architect").
- The guard costs one catalog query per `/readyz`.
- The api and ctl suites run through `LOGIN` roles (`rampsmith_test_api_login`,
  `rampsmith_test_ctl_login`); the first test of a cluster creates them, they own nothing, and
  their password is public.

## Plan correction

PLAN §9 "Tenancy enforcement" says the application role has no `BYPASSRLS`. Add: "Each service
verifies at startup, and `api` in `/readyz`, that its connection is a plain `LOGIN` member of
its group role (ADR-040)." PLAN §22 "Deploys": migrations run with `DATABASE_MIGRATE_URL`,
services with their login's `DATABASE_URL`.

## Rejected alternatives

- **`force row level security` on every tenant table.** It binds the table owner too, which
  would close the owner case, but a superuser and a `BYPASSRLS` role still ignore it, the
  migrations and `rsctl` would need exceptions, and it changes every existing policy's reach.
  The guard is cheaper and covers all three cases.
- **A flag that disables the guard for development.** The one environment where it matters
  least is also the one where the habit of connecting as the owner forms.
- **Creating the logins in a migration.** They need passwords; a migration would either embed
  one or create a login nobody can use.
