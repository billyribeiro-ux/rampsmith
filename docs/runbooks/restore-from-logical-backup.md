# Restore from the logical backup

| | |
| --- | --- |
| Answers | PLAN §22: the independent layer, and the 4-hour restore target. Nothing in PLAN §21 pages for it: the alerts for a stale or failed backup are proposed in ADR-179 and are **not built** |
| Severity | SEV1 |
| Use it when | The Railway project, environment or account is lost or unavailable; PITR is unavailable or suspect (a credential that can write to the archive may have leaked); or the data needed is older than the PITR window (up to 12 months, monthly copies). Otherwise prefer [PITR](restore-from-pitr.md). Choice table: ADR-176 |
| Decisions behind it | ADR-171 (what the backup is), ADR-172 (where it lives, retention), ADR-173 (encryption and who holds the key), ADR-175 (how it is verified), ADR-176, ADR-251 (the backup is a Railway cron service), ADR-252 (one bucket and one token per environment), ADR-256 (signed metadata), ADR-257 (restore as the migration role, table of contents check) |
| Verified | 2026-10-22. `restore.sh`, `verify.sh`, `restore-local.sh` and `list-backups.sh` run on every pull request against PostgreSQL 18.6 with the repository migrations, a real archive made and signed by `backup.sh` and a stand-in for R2 (restore drill, 20 negative cases). **Not run against a real R2 bucket or a Railway database**: Section E rows in `docs/evidence/ws-8-ops.md` and `docs/LAUNCH.md` |

## What you need before you start

| Item | Where it is |
| --- | --- |
| The private age key for the environment's backups | The founder's offline custody (ADR-173). It is never in CI. The staging drill key is a different, staging-only key |
| A read-only token for the backups bucket **of the environment you restore** | `R2_ACCOUNT_ID`, `R2_BUCKET_BACKUPS` (`rampsmith-backups-production`), `DRILL_R2_ACCESS_KEY_ID`, `DRILL_R2_SECRET_ACCESS_KEY` (LAUNCH.md C row 16), from the vault. This is the restore token of that environment (Object Read only on its bucket); it is **not** the engine's token (`R2_ACCESS_KEY_ID`, row 6), which cannot read the backups bucket, and not the backup service's write token. The weekly drill's token reaches the staging bucket only |
| The public key that verifies the backups | `infra/backup/signing/production.pub.pem` in the checkout of the release that was running (ADR-256). Backups are trusted only when their metadata verifies against it |
| A PostgreSQL 18 server you can reach as its superuser | A new Railway `postgres` service (first deploy creates it), or any PostgreSQL 18 server |
| The four database passwords | `RAMPSMITH_DB_PASSWORD_MIGRATOR`, `_API`, `_CTL`, `_ENGINE` from the vault (64 lowercase hex digits each). The restore itself runs as `rampsmith_migrator`; the superuser is needed only for the bootstrap in step 4 |
| The master key ring (current and previous) | The vault (PLAN §22). The backup holds only sealed values; without a ring that opens them, Shopify tokens are unreadable and merchants re-authenticate (survivable by design) |
| PostgreSQL 18 client programs, `age` 1.3.0 or newer, the `aws` CLI, a checkout of this repository at the release that was running | `age` v1.3.2 is what the workflows pin; a packaged `age` older than 1.3.0 cannot open a post-quantum-key archive |

A restore never goes over data: `restore.sh` refuses a target that already holds anything. It trusts a backup only when the metadata object's signature verifies against the committed public key, the signed time is not in the future, and the archive's size and SHA-256 are the signed ones; and it refuses an archive whose table of contents holds anything but objects of the application schema. The bucket is not trusted: anyone with a leaked write token could put a newer-looking object there.

## 1. Open the incident and choose the backup

1. Ticket, with the time the data was last good (UTC). Write in the ticket each time you connect to a database as a superuser, when it starts and ends, and why (break-glass, PLAN §18).
2. Work in a private terminal on a machine you trust. Make a private working directory: `umask 077; mkdir -p ~/restore-<ticket> && cd ~/restore-<ticket>`.
3. List the backups (the drill's read-only R2 variables for that environment, exported from the vault):

```sh
export R2_ACCOUNT_ID=... DRILL_R2_ACCESS_KEY_ID=... DRILL_R2_SECRET_ACCESS_KEY=... R2_BUCKET_BACKUPS=rampsmith-backups-production
infra/restore-drill/list-backups.sh --environment production
infra/restore-drill/list-backups.sh --environment production --kind monthly
```

Each line is `kind`, object key and a status, ordered by the time in the file name, newest first. Take the newest `complete` one (its signature verified against `infra/backup/signing/production.pub.pem`) unless the incident says to go back. `incomplete` is an unfinished upload or an object the backup service did not sign; `future` is dated ahead of the clock; `misfiled` sits in the wrong folder; `invalid` has a signature that does not verify. All four are objects somebody other than the backup service wrote or left half-written: restore.sh refuses them, and a `future`, `misfiled` or `invalid` one is a security signal for the incident (the write token of that bucket may have leaked). The key shows its date: `production/daily/2026-10-19/rampsmith-production-20261019T021700Z.dump.age`. The recovery point is that stamp, up to 24 hours before the incident.

## 2. Put the key where the script can read it, briefly

```sh
umask 077
read -rsp 'age identity (paste the AGE-SECRET-KEY-... line, then Enter): ' KEY; echo
printf '%s\n' "$KEY" > ./age-identity.key; unset KEY
```

On Linux, prefer a memory file system (`/dev/shm`) for it. The identity is deleted in step 7.

## 3. Rehearse the archive locally (recommended; no network, no production database)

This restores the archive into a throwaway PostgreSQL 18 started on a Unix socket and runs every check. If it fails, the archive or the key is the problem, and you learned it before touching the target.

```sh
export PGBIN="$(pg_config --bindir)" AGE=age AGE_KEYGEN=age-keygen
infra/restore-drill/restore-local.sh --object "<object key>" --verify-key infra/backup/signing/production.pub.pem \
  --identity ./age-identity.key --out ./local-out --work ./local-work --discard-work
```

It fetches the archive with the same variables as step 1, verifies the signature, restores into the throwaway server as `rampsmith_migrator` and prints `PASS` lines and the time. `--work` holds the restored data and is deleted when it ends; keep it away from `--out`, which only holds reports. `restore.sh` in step 5 does the real download with the same checks; this step is a rehearsal only.

## 4. Prepare the target

**Railway project still exists, database gone.** Run `deploy.yml` by hand from `main` with the release's digests (it creates the missing `postgres` service; the api's pre-deploy migration then stops because the logins do not exist). **Project lost.** Follow "Railway (C row 8)" in `docs/evidence/ws-9-deploy.md` (project, environments, shared variables from the vault, first deploy); the first deploy stops at the same place.

In both cases the database is empty. **Do not let a migration run before the restore**: the restored data carries its own migration table, and the next deploy applies only the migrations newer than the backup.

Open the private tunnel in terminal A (never a public proxy, ADR-182):

```sh
railway connect postgres --environment production --tunnel-only -P 55432
```

It prints Host, Port, User, Password and Database. In terminal B:

```sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=<User as printed> PGDATABASE=<Database as printed>
read -rsp 'superuser password: ' PGPASSWORD; export PGPASSWORD; echo
for name in MIGRATOR API CTL ENGINE; do
  read -rsp "RAMPSMITH_DB_PASSWORD_$name: " value; echo
  export "RAMPSMITH_DB_PASSWORD_$name=$value"
done; unset value
psql -v ON_ERROR_STOP=1 -f infra/railway/bootstrap.sql      # roles and schema owner (ADR-183); psql 15 or newer
unset RAMPSMITH_DB_PASSWORD_MIGRATOR RAMPSMITH_DB_PASSWORD_API RAMPSMITH_DB_PASSWORD_CTL RAMPSMITH_DB_PASSWORD_ENGINE
```

`pg_dump` does not dump roles, so a server without them is refused by `restore.sh`. On a server that is not Railway's, create an empty database first and run the bootstrap while connected to it.

## 5. Restore

From here on the connection is the **migration role**, not the superuser: the archive is SQL that this step runs, and `restore.sh` refuses a superuser connection (`RESTORE_ALLOW_SUPERUSER=1` overrides that for break-glass only; write it in the ticket if you use it).

```sh
export PGUSER=rampsmith_migrator
read -rsp 'RAMPSMITH_DB_PASSWORD_MIGRATOR: ' PGPASSWORD; export PGPASSWORD; echo
export PGBIN="$(pg_config --bindir)" AGE=age
infra/restore-drill/restore.sh --object "<object key>" --verify-key infra/backup/signing/production.pub.pem \
  --identity ./age-identity.key --target "$PGDATABASE" --jobs 4 --manifest-out ./expected.tsv --work ./work
```

Stages, each timed and printed at the end: **fetch** (download of the archive, its metadata object and the signature; the signature is verified, then the archive's size and SHA-256 against the signed ones), **decrypt** to a regular file in `./work` (`--jobs` needs a file), **list** (the archive's table of contents; it must hold `_sqlx_migrations` and nothing but objects of the application schema), **target** (connected as the migration role, roles present, nothing in the schema), **restore** (`pg_restore --no-owner --exit-on-error --jobs 4`), **analyze**. The decrypted plaintext is deleted when the script ends. Any failure stops with a message naming the step and exit code 1; fix the cause and, if the target holds objects, start from an empty database (`drop database` and create it again, then re-run the bootstrap while connected to it).

Record the elapsed time of each stage in the ticket: it is the measured restore time at production size (the CI figures are for a 361 KB fixture).

## 6. Verify

```sh
read -rsp 'RAMPSMITH_DB_PASSWORD_API: ' VERIFY_APP_PASSWORD; export VERIFY_APP_PASSWORD; echo
infra/restore-drill/verify.sh --expected ./expected.tsv --partial --min-tenants 1 --out ./verify-out   # still as rampsmith_migrator
```

`expected.tsv` was derived from the archive: its tables, policies, constraints, indexes and triggers, and the exact migration version from the metadata object. `verify.sh` checks they all exist, then checks through the `rampsmith_api` login that every tenant sees only its own rows, that a session without a tenant is refused and that a cross-tenant write is rejected. It exits 1 on any `FAIL`. Do not pass `--expect-schema-version`: the backup may be older than the repository's newest migration, which the next deploy applies.

Then look at the data the incident is about, and `psql -c "select count(*) from tenants"` against what you know.

## 7. Bring the services back, then clean up

1. Re-run the failed `deploy.yml` jobs, or run it by hand from `main` (the api's pre-deploy `sqlx migrate run` applies newer migrations, expand-then-contract, so it is safe on an older schema). `curl -fsS https://<app host>/readyz` must answer 200 (database and migration version).
2. Set the master key ring from the vault if the environment is new ([rotate the master key](rotate-token-master-key.md), step "Set"); run `rsctl doctor --row 12`. Without a ring that opens the restored tokens, each merchant re-authenticates the next time they open the app.
3. Expect the side effects described in [restore from PITR](restore-from-pitr.md), "After the restore": stale refresh tokens (merchants re-authenticate; this counts against the token SLO), jobs returning to `ready`, webhooks lost since the backup (Shopify retried for about 4 hours; reconcile longer gaps; GitHub redelivery within 3 days). For a backup up to 24 hours old, **all work since the backup is gone**: scans, fixes, approvals. Tell the postmortem which.
4. Turn PITR on for the new database: `railway postgres pitr enable --service postgres --environment production`.
5. Delete the plaintext and the key: `shred -u ./age-identity.key` (or remove the memory file), `rm -rf ./work ./dl ./local-out ./verify-out ./expected.tsv`; close the tunnel (Ctrl+C); clear the terminal; unset the exported variables.

## Rollback

The backup is only read, so the bucket is unchanged. If the restored database is wrong, drop it, create it empty, bootstrap and restore a different backup. Nothing is deleted from the old environment; keep it until the incident closes.

## Escalation

- A backup that will not decrypt or verify: try the next older complete backup, then the monthly copies. A key that cannot be found is the founder's decision and an immediate SEV1: PITR may still hold the data ([restore from PITR](restore-from-pitr.md)).
- No complete backup newer than the incident window, or the nightly job has not run: record it in the postmortem, and look at the `backup` service in Railway: its cron runs (`railway cron list --service backup --environment production`; Cron Runs tab in the dashboard) and the logs of the failed run, which name the missing input or the failing step; then C row 16's inputs (`rsctl doctor --row 16`). The proposed freshness alert (ADR-179) does not exist yet.
- A `future`, `misfiled` or `invalid` object in the listing: do not restore it. Treat the bucket's write token as leaked: rotate it (FOUNDER_SETUP section 16), keep the objects for the investigation (the bucket lock keeps the real ones), and open [incident response](incident-response-and-postmortem.md).
- Railway unavailable: <https://status.railway.com>; restore to another PostgreSQL 18 server (same steps, without Railway), then bring the services up there when the founder decides.
- Any suspicion that data was exposed: [incident response](incident-response-and-postmortem.md).
