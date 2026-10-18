# ADR-183: Migrations in the api's pre-deploy step, as a migration role, and per-service logins

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-9 (`infra/railway/railway.py`, `infra/railway/bootstrap.sql`)
- Refines: PLAN §9 and §22; ADR-006

## Context

PLAN §22: "Railway's pre-deploy command runs `sqlx migrate run`. Migrations are
expand-then-contract", and Railway switches traffic only after the readiness check passes.
The first migration (`crates/db/migrations/20261017000001_roles_and_tenant_context.sql`) says:
"Whoever runs migrations owns the tables. The application never connects as the owner: deploys
create LOGIN users that are members of these NOLOGIN group roles."

Railway's documentation, read on 18 Oct 2026:

- [Pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command): runs "between
  building and deploying", "in a separate container from your application", "within your
  private network and [with] access to your application's environment variables"; a non-zero
  exit means "it will not be retried and the deployment will not proceed"; an optional timeout
  of 1 to 3600 s.
- [Start command](https://docs.railway.com/deployments/start-command.md): exec form, so a
  variable needs `/bin/sh -c`.
- [Point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery.md): enabled
  on the database's Backups tab or with `railway postgres pitr enable --service postgres`;
  "The last 4 full backups are retained, giving you a restore window of roughly 4 weeks";
  "Keep the image on a major tag"; "minor version pinning is not supported with PITR"; the
  window starts at the first base backup after enabling.
- `railway connect postgres --ssh` opens `psql` through an SSH tunnel instead of a public TCP
  proxy (`src/commands/connect.rs`, Railway CLI 5.70.0).
- Railway's Python IaC helper `postgres()` uses `ghcr.io/railwayapp-templates/postgres-ssl:18`
  (`railway-sdk` 0.7.0).

A pre-deploy step shares the service's variables, so a migration credential given to `api`
also sits in the environment of the internet-facing api process.

## Decision

1. **Roles, created once per environment by `infra/railway/bootstrap.sql`** as the template's
   superuser, over `railway connect postgres --ssh`:
   - `rampsmith_migrator`: LOGIN, CREATEROLE (the first migration creates the group roles), owner
     of the `public` schema and of every object the migrations create; not a superuser, no
     BYPASSRLS, no replication.
   - `rampsmith_api` (member of `rampsmith_app`), `rampsmith_ctl` and `rampsmith_engine`
     (members of `rampsmith_worker`): LOGIN, nothing else. None owns a table or bypasses
     row-level security.
   - Passwords are the shared variables `RAMPSMITH_DB_PASSWORD_*` (64 hex digits). The founder
     enters each with `read -rsp` (no echo, no shell history, not in a process list) and psql
     reads them with `\getenv`. The script turns statement logging off for its session
     (`log_statement`, `log_min_error_statement`, `log_min_duration_statement`) and
     `pg_stat_statements.track_utility`, so the `ALTER ROLE ... PASSWORD` statements stay out of
     the server log and statistics; it refuses a missing, malformed or repeated password and a
     non-superuser session, and is safe to run again, which is how passwords rotate.
   - `rampsmith_engine` is, for now, as broad as `rampsmith_ctl` (both are `rampsmith_worker`).
     The engine only needs the job queue and its own results, so a narrower `rampsmith_engine`
     group role belongs in a migration (`crates/db/migrations`, owned by the database stream);
     until it lands, a compromised engine can read what ctl can. Open item in
     `docs/evidence/ws-9-deploy.md`.
2. **The api's pre-deploy step migrates as `rampsmith_migrator`:**
   `/bin/sh -c "DATABASE_URL=$MIGRATION_DATABASE_URL exec /usr/local/bin/sqlx migrate run --source /usr/local/share/rampsmith/migrations"`,
   with a 900 s timeout. `MIGRATION_DATABASE_URL` is a template over the migrator's shared
   password; no other service has it.
3. **The api process never sees that credential.** Its start command is
   `/bin/sh -c "unset MIGRATION_DATABASE_URL; exec /usr/local/bin/api"`: after `exec`, the
   api's `/proc/1/environ` holds no migration URL, which the image smoke test checks.
4. **Readiness gates traffic.** The api's Railway health check is `/readyz`, which answers 200
   only when the database holds this build's newest migration (`crates/api/src/health.rs`).
   `deploy.yml` moves the api first and waits for it before any other service gets new code
   (ADR-185).
5. **PostgreSQL** is Railway's template on its major tag, `postgres-ssl:18`, because PITR
   requires a major tag; Railway manages the minor version. This is the one image not pinned by
   digest, an explicit exception to CLAUDE.md's floating-tag rule that Railway's PITR forces:
   the tag names a major version, not `latest`, and the image is Railway's own template, which
   Railway updates in place. PITR is switched on once per environment by the founder
   (`railway postgres pitr enable --service postgres`). The database has no TCP proxy:
   Railway's template may add one, which the founder removes, and `ensure_network.py` fails
   every deploy while one exists (ADR-182).

## Consequences

- Integration work for the owner of `infra/api.Dockerfile`: the runtime image must contain
  `sqlx` (sqlx-cli 0.9.0, features `postgres` and `rustls`, as in `.mise.toml`) at
  `/usr/local/bin/sqlx` and `crates/db/migrations` at `/usr/local/share/rampsmith/migrations`,
  and keep `/bin/sh` (Debian slim has it). Until it does, the image smoke test reports a gap.
- An attacker who gains code execution in the api cannot read the migration URL from the
  process environment or from processes it starts. The value stays visible to anyone with
  access to the Railway project (dashboard, API, `railway ssh`), and Railway's runtime is not
  documented beyond that, so the migrator is deliberately not a superuser either: it cannot
  read server files, run programs on the database host or bypass row-level security on tables
  it does not own.
- `bootstrap_test.sh` proves on PostgreSQL 18 that the migrator can apply every migration, that
  no service login is privileged or can create objects, that row-level security refuses the api
  login without a tenant, that workers reach the queue, and that a second run rotates passwords.
- The first deploy to an environment must come after the bootstrap; `/readyz` stays 503 and the
  deploy fails until migrations run as the migrator.

## Rejected alternatives

- Migrating as the template's superuser: the api's environment would carry a superuser
  password.
- A separate always-on `migrate` service: Railway's documented deploy gate is the pre-deploy
  command; a run-to-completion service has no documented "finished successfully" state.
- Migrating from CI over a public TCP proxy: exposes the database to the internet.
- `postgres-ssl:18@sha256:...`: Railway documents PITR only for major tags, and a digest would
  stop the minor-version updates that PITR's base backups expect.
- Pinning PostgreSQL's minor version: not supported with PITR.

## Plan correction

PLAN §22, "Services" table, PostgreSQL 18 row, Notes cell. Replace it with:

> Railway's PostgreSQL 18 template on its major tag (PITR requires it; Railway applies minor
> releases); PITR enabled; no TCP proxy; logins per service from `infra/railway/bootstrap.sql`
> and migrations as `rampsmith_migrator` (ADR-183). Direct connections for `LISTEN`; a
> connection pool per service.

PLAN §7, "Toolchain" table, PostgreSQL row, Note cell. Append:

> Production runs Railway's `postgres-ssl:18`, whose minor version Railway manages (ADR-183).
