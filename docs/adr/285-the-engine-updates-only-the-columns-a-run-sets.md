# ADR-285: The engine may update only the columns a free-scan run sets

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-267
- Source: audit of the R1 integration, finding L2

## Context

Migration `20261105000008` granted `rampsmith_worker` update on all of `free_scans`. A compromised
engine could rewrite a visitor's `ip_hash` (to free or to burn their quota), `domain`,
`origin` or `expires_at`.

## Decision

Migration `20261108000004` revokes the table-level update and grants
`update (status, refusal, result, started_at, finished_at)`, which is everything a run changes
(`packages/engine/src/free-scan.ts` `begin` and `finish`; `free_scans_sweep()` is a security-definer
function and does not need the grant). The test `the_engine_can_update_only_what_a_run_changes`
(`crates/db/tests/free_scans.rs`) proves a run's updates pass and that `ip_hash`, `domain`,
`registrable_domain`, `origin`, `expires_at` and `created_at` are each refused with
`permission denied`. Merged migrations are not edited.

## Consequences

A column-level grant puts an `ACL public COLUMN` entry in a backup's table of contents. The restore
drill refuses any entry it does not know (ADR-257), so `rd_toc_violations` accepts `COLUMN` ACLs of
schema `public` (`infra/restore-drill/lib.sh`, tested in `infra/backup/tests/run.sh`). The first CI
run of this migration failed the drill and the backup tests until that line was added.


A new column the engine must write needs its own grant in a new migration.
