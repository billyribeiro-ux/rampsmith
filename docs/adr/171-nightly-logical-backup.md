# ADR-171: The nightly logical backup, in one streaming pass, written in bash

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`infra/backup/`, `docs/runbooks/`)
- Refines: PLAN §22 "Backups and recovery"; LAUNCH.md B7

## Context

PLAN §22 gives the database two layers: point-in-time recovery on Railway, and "an independent
logical backup: nightly `pg_dump -Fc`, encrypted with `age`, uploaded to a separate R2 bucket,
30 daily and 12 monthly". The recovery targets are at most 5 minutes of lost data and 4 hours to
restore. This ADR is the design of the second layer. ADR-172 covers the bucket, ADR-173 the
encryption, ADR-174 the workflow, ADR-175 the restore drill.

PostgreSQL 18 documentation, read on 19 Oct 2026 from its SGML sources (`doc/src/sgml/ref/pg_dump.sgml`,
`pg_restore.sgml`, `pg_dumpall.sgml`; the sandbox cannot reach postgresql.org, so the pages were read
in the project's source repository). They are published at
<https://www.postgresql.org/docs/18/app-pgdump.html>,
<https://www.postgresql.org/docs/18/app-pgrestore.html> and
<https://www.postgresql.org/docs/18/app-pg-dumpall.html>:

- `pg_dump` "makes consistent exports even if the database is being used concurrently" and does not
  block readers or writers. The same page adds that, "except in simple cases", it "is generally
  not the right choice for taking regular backups of production databases". That sentence is why
  this layer is the second one: PITR is the first.
- The custom format (`-Fc`) is compressed by default and is the input `pg_restore` selects from.
- By default `pg_dump` sets `row_security` to off "to ensure that all data is dumped from the
  table. If the user does not have sufficient privileges to bypass row security, then an error is
  thrown" (`--enable-row-security` is the opposite choice and dumps a filtered copy).
- `pg_dump` "cannot dump from PostgreSQL servers newer than its own major version"; it can dump
  from older ones.
- A dump holds one database. Roles and tablespaces are global objects: "use `pg_dumpall`".
- `pg_restore --jobs` needs "a regular file or directory (not, for example, a pipe or standard
  input)"; `--exit-on-error` stops at the first SQL error (the default is to continue and count);
  `--role` issues `SET ROLE` after connecting; `--no-owner` skips `ALTER OWNER`.

Railway documents its own volume backups
(<https://docs.railway.com/volumes/backups>): they restore "only into the same project +
environment" and "wiping a volume deletes all backups". They are useful as a manual snapshot before
a risky migration (`railway postgres pitr backup create --name pre-migration`), and they are not
independent of the account that holds the database.

## Decision

1. **One pass, nothing in plaintext on disk.** `infra/backup/backup.sh` runs
   `pg_dump -Fc | tee -p FIFO | age -R recipients -o archive.age`. The FIFO feeds
   `pg_restore --list`, which proves the stream is a PostgreSQL archive; the only file written is
   age's ciphertext. The script checks all three exit statuses (`PIPESTATUS`), and a failure of
   any of them leaves nothing in the bucket.
2. **Checks before upload.** The archive's table of contents must hold `public._sqlx_migrations`
   as a `TABLE DATA` entry (it is a Rampsmith database and the dump was not filtered) and at least
   one `POLICY` (the application schema is there). The size and SHA-256 of the ciphertext are
   recorded. The migration version and the server version are read with `psql` before the dump.
3. **A least-privilege login.** `infra/backup/backup-role.sql` creates `rampsmith_backup`:
   `LOGIN`, `BYPASSRLS`, member of the built-in `pg_read_all_data`, `default_transaction_read_only
   = on`, not a superuser, owning nothing. `BYPASSRLS` is not optional: without it `pg_dump` raises
   the row-security error quoted above, which is exactly how the backup tests prove the failure is
   loud (`no-bypassrls` in the drill, `BACKUP_DB_USER=rampsmith_api` in the backup tests). The
   consequence is that this login can read every tenant's rows. Its password is a secret of the
   `backup-production` and `backup-staging` GitHub environments only (ADR-174); the script reads
   it from the environment or standard input and never from a command line; the SQL file sets
   `log_statement = 'none'` for its session and reads the password with `\getenv`, as
   `infra/railway/bootstrap.sql` does (ADR-183).
4. **Metadata is the commit marker.** After the archive is uploaded and verified, the script writes
   `<key>.meta.json` (`rampsmith-backup-meta/1`: environment, kind, key, UTC time, size, SHA-256,
   age version, a fingerprint of the recipient list, server and `pg_dump` versions, migration
   version, table and policy counts, source transport, CI run URL). An archive without a metadata
   object is an unfinished upload: retention ignores it and `restore.sh` refuses it.
5. **Exit codes.** 0 stored and verified; 1 failed; 3 not configured (a missing C row 6 or row 8
   input), which the workflow turns into a warning annotation naming the rows (ADR-174).
6. **PostgreSQL 18 client programs from the pinned image.** The workflow wraps `pg_dump`,
   `pg_restore` and `psql` around `postgres:18.6-bookworm@sha256:afc7e2d4…` (the digest `ci.yml`
   pins). With the `railway-ssh` transport the dump runs inside the database container, whose
   `pg_dump` is the server's own. When Railway's `postgres-ssl:18` moves to a newer major version,
   the pinned client must move first (the documented rule above), and the drill's fresh server must
   move with it.
7. **Not dumped: roles.** `pg_dump` does not dump roles, so a restore target needs
   `infra/railway/bootstrap.sql` (ADR-183) first. `restore.sh` checks for the roles and stops with
   that sentence when they are missing; the drill has a `skip-bootstrap` negative case.
8. **Bash.** The job is a composition of four programs through pipes and a FIFO, with a rule that no
   plaintext reaches disk and no secret reaches a command line. A shell script is the smallest thing
   that does this; a Python or Rust wrapper would spawn the same four programs and add a runtime to
   a job that must run on a stock runner. The risks of shell are met with `set -euo pipefail`,
   `umask 077`, quoted expansions, and strict validation of every value that reaches a command
   (`BACKUP_ENVIRONMENT`, host, port, user, database names are matched against fixed patterns).
   ShellCheck 0.11.0 (SHA-256 pinned in the workflow) runs clean at its default severity over every
   script, and `infra/backup/tests/run.sh` (139 assertions when this ADR was written) runs the whole
   job against a throwaway PostgreSQL 18, a directory standing in for the bucket (`fake-aws.sh`)
   and a stand-in for `railway ssh` (`fake-railway.sh`), including mid-stream `pg_dump` death,
   corrupted and truncated uploads, a listing failure, a prune failure, and a private key placed in
   the recipient list.

## Consequences

- A backup that cannot be verified is not reported as a backup: the commit marker is last.
- The dump is as consistent as `pg_dump` is (one snapshot), and does not take locks that block the
  application; it does wait for table locks up to `--lock-wait-timeout=300s`, so a migration that
  holds an `ACCESS EXCLUSIVE` lock can delay or fail one night's run. A failed run is red in
  Actions; the next night's run is the retry.
- The recovery point of this layer alone is the time of the last successful run (up to about
  24 hours). The 5-minute target is met by PITR only (ADR-176).
- The `rampsmith_backup` login is the most powerful read credential in the system. It has no write
  access, no `CREATE`, and a read-only default transaction, but it bypasses row-level security by
  design. The security-auditor review owed at `max` (CLAUDE.md) covers it first.

## Rejected alternatives

- `pg_dumpall`: dumps the whole cluster as SQL text, including the template database's roles and
  Railway's own; not needed, and no custom format.
- Directory format with parallel `pg_dump -j`: needs a directory on disk, so the plaintext would be
  on disk before it is encrypted.
- `--enable-row-security` with an ordinary login: a quietly partial backup, which is worse than a
  failed one.
- Railway volume backups as the second layer: same provider, same project, deleted with the volume.
- Running `pg_dump` from a GitHub runner over a public database port: ADR-182 and ADR-183 keep the
  database off the internet; ADR-174 covers how the job reaches it.
- Python or Rust for the job: see decision 8.
