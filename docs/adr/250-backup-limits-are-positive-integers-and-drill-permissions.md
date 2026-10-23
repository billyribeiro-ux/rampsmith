# ADR-250: Backup limits are positive integers; the restore drill starts with no token permissions

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 (`infra/backup/backup.sh`, `.github/workflows/restore-drill.yml`)
- Refines: ADR-171, ADR-172, ADR-174, ADR-175; closes L7 and L10 of
  `docs/evidence/integration-security-audits-2026-10-19.md`

## Context

L7: `BACKUP_PRUNE_MAX` is the cap on how many objects one run may delete. Its value was used in an
arithmetic test without validation, so a non-numeric value either failed in an unclear way or, in some
shells, was evaluated as an expression. L10: `restore-drill.yml` declared `permissions: read-all` at the
top, so a job that forgot its own `permissions:` block would read every scope.

## Decision

- `backup.sh` checks `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_MONTHLY` and `BACKUP_PRUNE_MAX` against
  `^[1-9][0-9]*$` before it touches the database or the bucket, and stops with an error naming the
  variable. The value 0, a sign, a leading zero and any other text are refused. `tests/run.sh` covers
  each case.
- `restore-drill.yml` declares `permissions: {}` at the top; every job already states the scopes it
  needs (`contents: read`, or none). The nightly `backup.yml` no longer exists (ADR-251: the backup is a
  Railway cron service), so its half of L10 has nothing left to fix.

## Consequences

A mistyped limit fails the run loudly instead of changing what it deletes. A new job in the drill
workflow gets no token permission until it asks for one.
