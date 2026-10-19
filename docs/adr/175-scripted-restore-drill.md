# ADR-175: The scripted restore drill: what it proves, how it can fail, what it cannot prove

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`infra/restore-drill/`, `.github/workflows/restore-drill.yml`)
- Refines: PLAN §22 ("A restore drill runs every quarter ... record the measured recovery time") and
  §24 ("Quarterly | Restore drill"); LAUNCH.md B7 and section E; CLAUDE.md evidence rules

## Context

A backup nobody has restored is a hope. PLAN §22 asks for a quarterly drill; LAUNCH.md B7 asks for a
scripted one that runs on every pull request touching its paths and weekly, proves the restore
rather than assuming it, can be shown to fail, and has a live variant that restores the newest real
backup. The recovery target is 4 hours (14,400 s). PostgreSQL's restore behaviour is the one in
ADR-171 (`pg_restore` needs a regular file for `--jobs`, continues past errors unless told not to,
does not restore roles).

## Decision

1. **The drill** (`drill.sh`, in the pinned `postgres:18.6-bookworm@sha256:afc7e2d4…` image as user
   `postgres` with `--network none`; servers listen on Unix sockets only and run without `fsync`,
   because they are fixtures):
   1. provision a fresh PostgreSQL 18 cluster and bootstrap its roles (`sql/roles.sql`, the fixture
      twin of `infra/railway/bootstrap.sql`);
   2. apply the repository's migrations (`crates/db/migrations/*.sql`, in order) with a `psql`
      applier that writes `_sqlx_migrations` exactly as sqlx does, including the SHA-384 checksum;
   3. seed two tenants through the application login `rampsmith_api` (so row-level security applies to
      the seed), plus the identity rows and one system job that belong to no tenant;
   4. write the **manifest** (`sql/manifest.sql`) from one `REPEATABLE READ` snapshot: migration
      version and count; per table the row count, an order-independent content checksum (the sum of a
      64-bit digest of each row's text; a corruption detector, not a cryptographic hash), owner,
      row-level-security flags and a digest of the privileges; a digest of every policy, constraint,
      index, trigger, function and partition; and the attributes and memberships of the roles a
      restore needs (449 entries over 17 tables on the CI fixture);
   5. run the real `backup.sh` against the source (the bucket is a directory behind `fake-aws.sh`),
      encrypting to a throwaway age key;
   6. **restore window** (timed): the real `restore.sh` into a second, fresh cluster;
   7. inject the fault, if any (`DRILL_FAULT`);
   8. `verify.sh`: the manifest taken now equals the manifest taken at dump time; the migration version
      equals the repository's newest; for every tenant and every tenant table, the application login
      sees that tenant's rows and none of any other tenant's; the application login without a tenant is
      refused; a cross-tenant write is rejected; and the elapsed restore window is inside
      `RTO_TARGET_SECONDS` (14,400).
2. **It can fail.** `tests/negative.sh` runs the drill once clean and once per injected fault, and the
   drill must exit non-zero with the message that names the fault. The faults: a tampered manifest
   checksum, tampered data, a dropped policy, row-level security disabled on a table, a dropped table,
   a truncated table (written under `session_replication_role = replica` to get past the append-only
   trigger), a dropped grant, a stale backup (older schema version), corrupted ciphertext, the wrong
   age key, the roles missing on the target, a non-empty target, a backup login without `BYPASSRLS`, and
   an exceeded RTO (`RTO_TARGET_SECONDS=0`). They include the three the task named (a tampered
   checksum, a dropped policy, a missing table). 15 cases (the control and 14 faults), 0 failures on CI
   run 39296924492 (job `drill`; the negative suite took 54 s).
3. **The restore path of a real backup runs on every pull request too.** `restore-local.sh` restores one
   archive into a fresh cluster and verifies it against what the archive itself says: a manifest derived
   from its table of contents (tables, policies, constraints, indexes, triggers, with partitions
   recognised and excluded) and the exact migration version in the metadata object, then the isolation
   checks. The workflow runs it on the drill's own archive, so the code the live variant uses is
   exercised without any secret.
4. **The live variant** (`live.sh`, job `live restore (staging)`, weekly and on `workflow_dispatch`, not on
   pull requests; GitHub environment `backup-staging`): list `staging/daily/` in the R2 backups bucket,
   take the newest complete backup, refuse it if it is older than 48 hours (the nightly job is not
   running), download, check size and SHA-256 against the metadata object, decrypt with
   `BACKUP_DRILL_AGE_KEY`, and run `restore-local.sh`. It adds the download time to the restore window
   and compares the total with 14,400 s. Without C rows 6 and 8 it exits 0 with
   `::warning::live restore drill skipped: needs <names> (LAUNCH.md section C rows 6 and 8); the
   substitute test ... ran in this workflow`, and the tests assert that text (`infra/backup/tests/run.sh`).
   "Staging" because only staging backups are encrypted to a key the workflow holds (ADR-173).
5. **Schedule and triggers.** `pull_request` on `infra/restore-drill/**`, `infra/backup/**`,
   `crates/db/migrations/**` and the two workflow files; `schedule` on `41 5 * * 1` (weekly, Monday);
   `workflow_dispatch`. Jobs: `lint` (ShellCheck 0.11.0 and actionlint 1.7.12, pinned by SHA-256),
   `drill`, `backup-tests`, `live`. Artifacts: the drill report (timings, verify output, negative
   results), 30 days.
6. **What the timings mean.** The CI fixture is 361 KB of archive; the restore window was 1.47 s of the
   14,400 s target (it includes starting the second server, about 0.8 s: fetch 19 ms, decrypt 5 ms,
   list 16 ms, target check 38 ms, restore 109 ms, analyze 107 ms, verify 383 ms). That proves the procedure and its checks,
   not the recovery time of a production-sized database. The RTO is only measured when the live variant
   restores a real staging backup, and it is measured there with the real size, over the real network.
   No extrapolation is claimed.

## Consequences

- A change to a migration that breaks restore (a new role, a table the manifest cannot read, an object a
  dump cannot carry) fails the pull request that introduced it. The drill's roles file must follow
  `bootstrap.sql` when logins are added (it already mirrors `rampsmith_engine`).
- The manifest's checksum covers table contents but not large-object data, extensions' own tables or
  sequences' current values; the schema has none of the first two, and sequence values are covered
  indirectly by the rows that use them. If the schema grows any of them, the manifest grows with it.
- The drill proves the application role isolates tenants after a restore; it does not prove the
  application works. A smoke test against the restored database belongs to the PITR cutover runbook.
- Running with `--network none` and Unix sockets means the drill cannot be disturbed by, and cannot
  disturb, anything else on the runner.

## Rejected alternatives

- Comparing only row counts: misses changed rows, which is what the checksum is for (the `tamper-data`
  fault).
- `pg_dump` plain format and `diff`: cannot see ownership, privileges or row-level security flags.
- Restoring into the CI `postgres` service container: the version and the lifecycle are the runner's;
  the pinned image started by the script is what the production image's major version is.
- A drill that only ever passes: the negative suite exists because of this.
- Quarterly only: the PITR half of PLAN §22 cannot be scripted (it needs the Railway account), so the
  human quarterly drill remains for that half (`docs/runbooks/restore-from-pitr.md`); the logical half
  runs on every relevant pull request and weekly.

## Plan correction

PLAN §22, "Backups and recovery", the paragraph after the table. Replace its first sentence with:

> A scripted restore drill runs on every pull request that touches the backup scripts, the drill or the
> migrations, and every week: it restores a fresh backup into a fresh PostgreSQL 18, compares per-table
> row counts and content checksums with a manifest written at dump time, checks that row-level security
> still isolates tenants through the application role, and fails when the restore takes longer than the
> 4-hour target. The live variant restores the newest real staging backup weekly. Each quarter a person
> also restores into staging from point-in-time recovery and records the measured time (ADR-175,
> ADR-176).

PLAN §24, "Scheduled pipelines", add the row: `Weekly | Scripted restore drill (restore-drill.yml)`.
