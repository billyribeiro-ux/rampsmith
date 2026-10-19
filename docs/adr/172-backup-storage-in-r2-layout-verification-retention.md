# ADR-172: Backup storage in R2: layout, verification, retention, lifecycle rules and locks

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`infra/backup/`)
- Refines: PLAN §22 "Backups and recovery"; LAUNCH.md C row 6; ADR-182 (`R2_BUCKET_BACKUPS`)

## Context

PLAN §22: "Nightly `pg_dump -Fc`, encrypted with `age`, uploaded to a separate R2 bucket", kept for
"30 daily, 12 monthly". LAUNCH.md C row 6 lists the Cloudflare inputs, including `R2_BUCKET_BACKUPS`;
ADR-182 keeps that variable out of Railway ("the WS-8 backup job") and gives every environment its
own R2 buckets and tokens. The task was to check how R2 lifecycle rules and the job itself can prune,
and to record the choice.

Cloudflare documentation, read on 19 Oct 2026 (the sandbox cannot reach developers.cloudflare.com, so
the pages were read in the `cloudflare/cloudflare-docs` repository, `src/content/docs/r2/`):

- [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/): `PutObject`, `GetObject`,
  `HeadObject`, `DeleteObject`, `ListObjectsV2` (`prefix`, `continuation-token`, `start-after`,
  `max-keys`, `delimiter`), `CopyObject` and the multipart operations are supported. S3 versioning
  (`PutBucketVersioning`), S3 Object Lock (`PutObjectLockConfiguration`, the `x-amz-object-lock-*`
  headers), tagging and ACLs are not. The page lists the checksum algorithms R2 stores
  (`CRC64NVME` full-object; `CRC32`, `CRC32C`, `SHA1`, `SHA256` composite).
- [aws CLI example](https://developers.cloudflare.com/r2/examples/aws/aws-cli/): endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; the region may be `auto` "since it is required by
  the SDK but not used by R2".
- [Limits](https://developers.cloudflare.com/r2/platform/limits/): 5 TiB per object, 10,000 parts, one
  concurrent write per second to the same key (higher rates return HTTP 429).
- [API tokens](https://developers.cloudflare.com/r2/api/tokens/): "Object Read & Write" tokens can be
  scoped to specific buckets and work only with the S3-compatible API; bucket configuration needs an
  Admin permission or `Workers R2 Storage Write`.
- [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/): rules delete
  objects by age or date, by prefix (at most 1,000 rules); "objects will typically be removed ...
  within 24 hours of the `x-amz-expiration` value"; managing them is a bucket-level action that needs
  `Workers R2 Storage Write`; buckets already abort multipart uploads seven days after initiation.
  There is no rule that keeps "the newest N objects".
- [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/): rules by prefix prevent
  "the deletion and overwriting of objects ... for a specified period"; "Bucket lock rules take
  precedence over lifecycle rules"; "a bucket cannot be emptied while any bucket lock rules are
  configured".
- GitHub's `ubuntu-24.04` runner image 20261012.334.1 ships AWS CLI 2.37.13
  ([runner-images](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)),
  so the job installs nothing to talk to R2.

botocore (the AWS CLI v2 engine) defaults `request_checksum_calculation` and
`response_checksum_validation` to `when_supported`; the AWS CLI configuration reference documents the
`when_required` alternative.

## Decision

1. **Layout.** One bucket per environment (`R2_BUCKET_BACKUPS` is a variable of the GitHub
   environments `backup-production` and `backup-staging`, ADR-174), and inside it the environment's
   name as the first key segment, so a mis-set bucket variable can never make one environment prune the
   other's objects:

   ```text
   <env>/daily/YYYY-MM-DD/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age
   <env>/daily/YYYY-MM-DD/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.meta.json
   <env>/monthly/YYYY-MM/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age
   <env>/monthly/YYYY-MM/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.meta.json
   ```

   Keys never repeat (the stamp has seconds), so nothing is overwritten, which is what a bucket lock
   needs.
2. **One token per bucket, no more than it needs.** An "Object Read & Write" token scoped to the one
   backups bucket. It cannot change lifecycle or lock configuration (that is why the founder applies
   those, below) and it is not the evidence bucket's token (ADR-182).
3. **Upload and verify.** `aws s3 cp` (multipart as the CLI decides), then `HeadObject` for the size,
   then a second download streamed through `sha256sum`, both compared with what was sent; only then is
   the metadata object written. The checksum settings are `when_required` for request and response, as
   a precaution: R2's documentation lists the algorithms it stores, not the CLI's default streaming
   trailer behaviour, and the script verifies integrity itself. Whether the default `when_supported`
   would also work against a live bucket is not checked (Section E).
4. **The monthly copy.** If the month has no complete monthly backup yet, the run stores the archive a
   second time under `monthly/`. A missed first of the month is made up by the next run.
5. **Retention is the job's, by count of complete periods** (`bk_retention_victims`). A period is a
   day (daily) or a month (monthly); it is complete when it holds an archive and its metadata. The
   cutoff is the 30th (12th) newest complete period; every key of an older period is a victim.
   Rules: only keys matching this environment's exact naming are ever victims; an incomplete period
   newer than the cutoff is never deleted and never counted; fewer than the count means nothing is
   deleted; the period in the directory must equal the stamp in the file name; deletes run only after
   the new backup is stored and verified; and more than `BACKUP_PRUNE_MAX` (10) victims in one run
   refuses to delete and fails the job with the backup safe, so a mistaken `BACKUP_KEEP_*` or a
   mis-pointed bucket cannot empty it. The tests run the real script over a directory standing in for
   the bucket, including a failing `DeleteObject`.
6. **Lifecycle rules are not the retention.** They delete by age, so they would keep deleting the
   last good backups if the nightly job stopped. `infra/backup/r2/lifecycle.json` therefore sets only
   a cost cap far beyond the retention (daily 60 days, monthly 450 days), in the JSON shape of
   `wrangler r2 bucket lifecycle set <bucket> --file`. The risk stays: if backups stop and nobody
   notices for 60 days, the cap deletes the last daily archive. The founder applies this file only
   after a backup-freshness alert exists (ADR-179, Section E row); until then the job's own pruning is
   the only deletion.
7. **Bucket locks are worth applying now.** `infra/backup/r2/bucket-lock.json` locks daily objects for
   25 days and monthly objects for 300 days, so a stolen backup token cannot delete or overwrite a
   recent backup. They sit below the retention (30 days, 12 months), so the job's own pruning is
   never refused; lowering `BACKUP_KEEP_DAILY` below 25 would make the prune step fail loudly
   (`could not delete`), which is the intended behaviour. A locked bucket cannot be emptied, so
   decommissioning an environment starts by removing the lock rules. `infra/backup/tests/run.sh` checks
   both files against the retention (a cap longer than 30 days and 366 days, a lock shorter than 30 and
   334 days, the four key prefixes) and that an edit shortening a cap or lengthening a lock is caught,
   so a change to either number fails the pull request instead of surprising the founder.
8. **Only the founder applies 6 and 7**, with an account-level token or the dashboard, because the
   backup token cannot (decision 2). Both are in Section E of `docs/evidence/ws-8-ops.md`.

## Consequences

- Loss of the nightly job does not lose backups: counting never deletes the newest complete ones, and
  an unfinished upload is invisible to retention and to restore.
- A key-naming change would orphan old backups (they would stop matching the victim pattern, so they
  would stay forever). The format version in the metadata object (`rampsmith-backup-meta/1`) is the
  hook for a migration.
- Re-downloading each archive for the hash doubles the job's transfer and adds its duration to the
  run. Neither is measured live (Section E); the job has a 90-minute timeout. If that becomes a
  problem, verifying `HeadObject` size plus a sampled set of byte ranges is the alternative, and it
  would be a new ADR.
- Nothing here has run against a real bucket. Substitute tests cover every code path against a
  directory; the live checks are named in Section E with the C rows they need (6 and 8).

## Rejected alternatives

- Lifecycle rules as the only retention: age-based, so a stopped pipeline loses data.
- S3 Object Lock or bucket versioning: R2 does not support them (S3 API page above).
- One bucket for both environments: one mistake from pruning the wrong one; ADR-182 already separates
  credentials per environment.
- Trusting `aws s3 cp`'s own success without a size and hash check: it checks the transfer, not that
  the object R2 stored is the one we meant to keep.

## Plan correction

PLAN §22, "Backups and recovery" table, row "Independent logical backup". Replace the row with:

> | Independent logical backup | Nightly `pg_dump -Fc`, encrypted with `age`, uploaded to a separate R2 bucket under `<environment>/daily/` and `<environment>/monthly/`, verified by size and SHA-256 before its metadata object is written | The job keeps the newest 30 daily and 12 monthly complete backups and refuses to delete more than 10 objects in one run; bucket locks hold daily objects 25 days and monthly objects 300 days (ADR-172) |
