# ADR-176: Restore procedures: when to use point-in-time recovery, when the logical backup, and what is not verified

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`docs/runbooks/restore-from-pitr.md`, `docs/runbooks/restore-from-logical-backup.md`,
  `infra/restore-drill/restore.sh`)
- Refines: PLAN §22 "Backups and recovery"; ADR-171 to ADR-175, ADR-183

## Context

PLAN §22 has two layers and two targets: at most 5 minutes of lost data and 4 hours to restore. Railway
documentation, read on 19 Oct 2026 from the `railwayapp/docs` repository (`content/docs/…`, published at
<https://docs.railway.com/volumes/point-in-time-recovery>, <https://docs.railway.com/cli/postgres>,
<https://docs.railway.com/cli/connect>, <https://docs.railway.com/cli/ssh>,
<https://docs.railway.com/volumes/backups>, <https://docs.railway.com/variables/reference>), and the
Railway CLI 5.70.0 sources at the pinned tag (`src/commands/postgres.rs`, `database/pitr.rs`,
`connect.rs`, `down.rs`):

- PITR archives every WAL segment with pgBackRest to a Railway bucket; the image writes
  `archive_mode=on` and `archive_timeout=60`; pushes are asynchronous; "Under sustained S3 outages, a
  5 GiB queue cap on the leader trips and pgBackRest drops WAL to keep the database running — your PITR
  window truncates, but Postgres stays up". Base backups: a full one weekly, a differential daily; "the
  last 4 full backups are retained, giving you a restore window of roughly 4 weeks"; the window starts at
  the first base backup after PITR is enabled.
- A restore "creates a brand-new service ... named `<source>-restored-YYYYMMDD-HHMM`", with an empty
  volume "sized to the larger of the source's volume and your plan's default volume size", the same
  image and the source's variables, and recovery variables set to the target time. "The source service is
  never touched." After it finishes "you have two services side by side ... Cut over by swapping
  connection strings, copying out the rows you need, or replacing the source service with the fork."
  The fork is a plain non-archiving database; PITR must be enabled on it again. The recovery variables
  hold the archive bucket's read/write credential, so anyone who can read the fork's variables can write
  to the source's archive.
- `railway postgres pitr status --service postgres` shows configuration, restore coverage and archiver
  health (the CLI reads `pg_stat_archiver` and `pgbackrest info` over SSH);
  `railway postgres pitr restore --service postgres --at <RFC 3339 | "YYYY-MM-DD HH:MM:SS" | 30m | 2h |
  1d> [--new-service-name NAME] [--source-repo-path PATH] [--yes]` restores. Commands that prompt fail
  non-interactively without `--yes`.
- The image must stay on a major tag (`postgres-ssl:18`), as ADR-183 already records.
- `railway connect <service> --tunnel-only [-P PORT]` opens an SSH tunnel to a database with no public
  proxy and "holds the tunnel open until Ctrl+C"; it prints the host, port, user, password and URL to
  standard error. `railway down --service S --environment E --yes` removes a service's most recent
  deployment (stops it). The CLI has no command that renames a service; renaming is a dashboard action.
- Reference variables use the referenced service's name as the namespace
  (`${{postgres.RAILWAY_PRIVATE_DOMAIN}}`, `${{shared.NAME}}`). The page does not say what happens to
  references, or to `<service>.railway.internal`, when a service is renamed or deleted (checked
  19 Oct 2026; the Services page is silent as well).
- In this project every service builds `DATABASE_URL` from the shared login passwords and
  `${{postgres.RAILWAY_PRIVATE_DOMAIN}}` and `${{postgres.PGDATABASE}}` (`infra/railway/railway.py`,
  ADR-182, ADR-183), and the IaC checks the plan it applies against dashboard drift.

## Decision

1. **Choosing the layer.**

   | Situation | Use | Data loss | Why |
   | --- | --- | --- | --- |
   | A bad migration, a bad delete or a bug damaged data in the last 4 weeks; the database still runs | PITR to the minute before | seconds to about a minute (`archive_timeout=60`) plus archive lag | The only layer with a target in minutes |
   | The database service or its volume is gone, the Railway project still exists | PITR (the archive bucket is separate from the volume) if it is intact; otherwise the logical backup | as above, or up to the age of the last backup | Check `pitr status` first |
   | The Railway project, environment or account is lost or unavailable | Logical backup into any PostgreSQL 18 server | up to about 24 hours (nightly) | Independent of Railway by design (ADR-171) |
   | A credential that can write to the PITR archive may have leaked, or the archive is suspect | Logical backup from before the exposure | up to the age of that backup | The fork's recovery variables hold a read/write bucket credential (above); R2 backups sit behind locks (ADR-172) |
   | The data needed is older than 4 weeks, up to 12 months | Logical backup, monthly copy | up to a month | PITR window |
   | The token master key was lost | No restore | none | Merchants re-authenticate through token exchange (PLAN §22) |

2. **Targets, stated honestly.** The 5-minute target is a PITR property and is met only while archiving is
   healthy (alert in PLAN §21; ADR-179). The logical backup's recovery point is the last successful
   nightly run. The 4-hour target covers fetch, restore, verification and cutover; the scripted drill
   measures the first three on a fixture (ADR-175), PITR's restore time and the cutover have never been
   measured, and both are Section E rows: the quarterly drill records them.
3. **PITR runbook shape** (`restore-from-pitr.md`): check archiver health; stop writers (`railway down`
   for `api`, `ctl`, `engine`) if the damage is ongoing; restore to a named sibling; open a tunnel to the
   fork and verify it (`verify.sh` with the application login, plus the checks the incident needs);
   then one of two outcomes. *Copy out*: dump only the needed tables from the fork and load them into the
   primary after review. *Cut over*: the dashboard rename of the services, which keeps the
   `${{postgres.…}}` references and the IaC's expectations as they are. **Whether references and the
   private network name follow a rename is not documented and not verified** (the context above). If
   Railway rewrites references when the old service is renamed, the services would still read the old
   database after the fork takes the name `postgres`, silently. So the runbook (a) says to rehearse the
   cutover in staging before relying on it, (b) ends the cutover with a check that cannot be fooled: the
   application logins (`rampsmith_api`, `rampsmith_ctl`, `rampsmith_engine`) must appear in
   `pg_stat_activity` of the new database and be absent from the old one, and (c) gives the fallback when
   they do not: run `deploy.yml` by hand from `main` with the current commit and digests, whose apply sets
   the variables from the IaC again. The runbook never edits `DATABASE_URL` by hand in production,
   because the IaC would revert it at the next deploy.
4. **Logical restore** (`restore-from-logical-backup.md`) uses `infra/restore-drill/restore.sh`, the same
   script the drill runs: fetch with size and SHA-256 checks against the metadata object, decrypt to a
   regular file (`--jobs` needs one), list the archive, check the target is an empty database on a server
   that already has the roles from `infra/railway/bootstrap.sql`, `pg_restore --no-owner
   --role rampsmith_migrator --exit-on-error --jobs N`, `analyze`. Then `verify.sh --partial` against the
   manifest derived from the archive. `restore.sh` never restores over data and refuses an archive whose
   metadata object is missing.
5. **Both runbooks use a private tunnel,** `railway connect … --tunnel-only` by hand, never a public TCP
   proxy (ADR-182 fails any deploy while one exists). The tunnel prints the database superuser's password
   to the terminal; the runbooks say to use a private terminal and clear it afterwards.
6. **Break-glass.** Production database access by a person is break-glass with a second person notified
   (PLAN §18); every runbook step that connects as a superuser says so and names the incident ticket as
   the place to record it.

## Consequences

- The restore time of a production-sized database is unknown until the first live drill (Section E).
- A cutover that depends on rename semantics is the weakest step in the 4-hour path. The mitigation is the
  rehearsal in staging and the "copy out" alternative, which needs no rename.
- Because the fork restores roles and their passwords with the cluster (a physical restore), the shared
  `RAMPSMITH_DB_PASSWORD_*` values keep working; a logical restore needs the bootstrap script first
  and sets them again.

## Rejected alternatives

- Editing each service's `DATABASE_URL` to point at the fork: the IaC would revert it, and a half-edited set
  of services is the likelier outcome during an incident.
- A hot standby or HA cluster at launch (`railway postgres ha convert`): a cost and complexity decision for
  the founder (PLAN §20); PITR plus the logical backup is the plan of record.
- Restoring the logical backup directly over the live database (`pg_restore --clean`): destroys the evidence
  and the only copy of whatever is not in the backup.

## Plan correction

PLAN §22, "Backups and recovery", the sentence "Recovery targets: at most 5 minutes of lost data and 4 hours
to restore" at the top of section 22 stays; add after the table:

> Point-in-time recovery meets the 5-minute target while WAL archiving is healthy (Railway sets
> `archive_timeout` to 60 seconds); a restore creates a sibling service and cutting over to it is a manual
> step. The logical backup's recovery point is the last nightly run, up to about 24 hours. The 4-hour target
> is measured by the restore drill (ADR-175) for the restore itself and by the quarterly human drill for
> point-in-time recovery and cutover (ADR-176).
