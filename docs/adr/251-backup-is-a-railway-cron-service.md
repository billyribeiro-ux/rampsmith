# ADR-251: The nightly backup is a Railway cron service, not a GitHub workflow

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Supersedes ADR-174; refines ADR-171, ADR-173

## Context

The first design ran the backup as a scheduled GitHub workflow in the environments `backup-production` and `backup-staging` (ADR-174). That put a credential that can write backups, and the database password, in GitHub, in a public repository whose scheduled workflows are disabled after 60 days without activity and may be delayed or dropped under load (GitHub, "Events that trigger workflows"). The pull request that merged the cron service (PR #21) replaced it, but the decision was only written in comments citing ADR-090 to ADR-094, numbers that were never created as files. This record is that decision, written once.

Railway documentation (cron jobs, `docs.railway.com/reference/cron-jobs`, read 22 Oct 2026): a cron service is started on its schedule in UTC and must exit when done, a run is skipped while the previous one is still active, and `railway cron list` and `railway cron run` inspect and trigger it. Railway private networking (`docs.railway.com/reference/private-networking`) lets the service reach `postgres.railway.internal` without a public endpoint.

## Decision

- `infra/railway/railway.py` declares a service `backup` in staging and production: image built from `infra/backup/Dockerfile`, cron `17 2 * * *`, no port, no health check, no public domain.
- It dumps over the private network, encrypts with age, signs the metadata (ADR-256) and uploads to its environment's bucket (ADR-252).
- GitHub holds no credential that can write a backup. `backup.yml` stays deleted.
- A run that is not configured exits 3 with a notice naming the missing input (CLAUDE.md, LAUNCH.md section E).

## Consequences

The scheduler and the database credential are inside the platform that already holds the database. A failed or skipped run is visible in the service's deployment logs and `railway cron list`, not in a workflow run. The runbook cites those.

## Rejected alternatives

- GitHub scheduled workflow (ADR-174): holds a write credential in a public repository; schedule is best effort and auto-disabled after 60 days of inactivity.
- A sidecar in the API service: couples backup failure to API availability.
