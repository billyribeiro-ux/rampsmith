# ADR-252: One R2 bucket and one backup token per environment; the drill reads staging only

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Refines ADR-172, ADR-152; closes finding M2 and MEDIUM-2 of the 22 Oct 2026 re-audit

## Context

Backups of production were written to a bucket shared with staging, with a token that could write both. A leak of the staging service's token would have allowed deleting or replacing production's backups, and the drill's read token reached every environment's objects.

Cloudflare R2 API tokens can be scoped per bucket to Object Read only or Object Read and Write (Cloudflare docs, "R2 API tokens", read 22 Oct 2026). Bucket locks and lifecycle rules are set per bucket with `wrangler r2 bucket lock set` and `wrangler r2 bucket lifecycle set`, each with `--file` (Cloudflare docs, "Bucket locks", "Object lifecycles").

## Decision

- Buckets: `rampsmith-backups-production` and `rampsmith-backups-staging`. The name must end in `-<environment>`; `bk_bucket_matches_environment` enforces it in `backup.sh`, `restore.sh`, `list-backups.sh` and `live.sh`.
- Tokens: one Object Read and Write token per environment, scoped to its bucket, held as sealed Railway variables of that environment's `backup` service only (ADR-253). The drill token is Object Read only on the staging bucket, a secret of the GitHub environment `backup-drill`. A production restore token is Object Read on the production bucket and lives in the founder's vault, not in any service or workflow.
- Each bucket gets `infra/backup/r2/bucket-lock.json` and `lifecycle.json` applied by the founder (FOUNDER_SETUP.md section 10). Locks and lifecycle need an account API token, which `rsctl doctor` does not hold, so no doctor check is possible; LAUNCH.md row 16 and section E carry the manual step.

## Consequences

A leaked staging token reaches staging backups only. The live drill never reads production data, which also keeps customer data out of a public CI runner.

## Rejected alternatives

- One bucket with prefixes per environment: a bucket-scoped token cannot be narrowed to a prefix.
- One token for all: the original design, the finding.
