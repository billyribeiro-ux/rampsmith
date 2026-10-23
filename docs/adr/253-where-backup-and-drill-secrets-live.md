# ADR-253: Where backup and drill secrets live

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Refines ADR-173, ADR-151

## Context

GitHub environments are created unprotected when a workflow names one that does not exist (GitHub, "Managing environments"). Repository and organization secrets are readable by every workflow and, for some events, by pull-request workflows. Railway sealed variables cannot be read back through the dashboard or API after they are set, are not copied to pull-request environments or duplicated environments, and are not returned by `railway variables` (Railway docs, "Variables", read 22 Oct 2026). Shared variables are per environment.

## Decision

- Backup variables (`R2_*` write token, `BACKUP_AGE_RECIPIENTS`, `BACKUP_DB_PASSWORD`, `BACKUP_SIGNING_KEY`) are Railway variables of the `backup` service, sealed in every environment.
- The only GitHub secrets are those of the environment `backup-drill`: the read-only token, the drill's age private key. `drill-scope` fails if any backup or drill secret exists as a repository or organization secret; `drill-protection` fails unless `backup-drill` deploys from main only.
- `rsctl` reads each value into a `Secret`, including the drill private key (finding LOW-4).

## Consequences

No workflow other than the live drill job can read a backup credential, and that job starts only after both checks pass.

## Rejected alternatives

- Repository secrets: readable by every job.
