# Restore from point-in-time recovery (PITR)

| | |
| --- | --- |
| Answers | PLAN §21 page "PostgreSQL WAL archiving failing"; the recovery targets of PLAN §22 (at most 5 minutes of lost data, 4 hours to restore) |
| Severity | SEV1 when data was lost or damaged; SEV2 when only archiving is failing |
| Use it when | Data was damaged or deleted in the last 4 weeks and the database still runs; or the database service or volume is gone but the Railway project exists. If the project is lost, use [restore from logical backup](restore-from-logical-backup.md). The choice table is in ADR-176 |
| Decisions behind it | ADR-176 (layers, cutover), ADR-183 (database logins), ADR-182 (no public database proxy) |
| Verified | 2026-10-19 against the Railway documentation and the Railway CLI 5.70.0 sources (the version `deploy.yml` pins). **Not run against a live Railway project**: the first run is the quarterly drill below and is a Section E row |

## What exists, and what does not

| Piece | State |
| --- | --- |
| `railway postgres pitr status \| restore \| enable` | Railway CLI 5.70.0 |
| `infra/restore-drill/verify.sh` (checks a restored database) | Built, runs on every pull request in the restore drill |
| `infra/railway/bootstrap.sql` (database logins) | Built on `ws/deploy` until that branch merges |
| Cutover by renaming services | **Not verified.** Railway documents the restore as a sibling service and says "cut over by swapping connection strings, copying out the rows you need, or replacing the source service with the fork"; it does not say what happens to `${{postgres.…}}` references or the private network name when a service is renamed. Rehearse in staging first |
| Restore time of a production-sized database | **Not measured.** Section E row |

## 1. Open the incident and decide the time

1. Open the ticket (see [incident response](incident-response-and-postmortem.md)). Write the **last time the data was good**, in UTC, with how you know. The restore target is a minute before it.
2. A person connecting to production as the database superuser is break-glass (PLAN §18). Write in the ticket, when it starts and ends, who and why.
3. Work in a private terminal. The tunnel in step 5 prints the superuser's password to the screen.

Set once per terminal (`production` or `staging`):

```sh
export ENV_NAME=production
railway --version          # 5.70.0 or newer; log in as yourself: railway login
railway link               # pick the Rampsmith project; every command below names the environment
```

## 2. Check that the archive covers the time

```sh
railway postgres pitr status --service postgres --environment "$ENV_NAME"
```

It prints the configuration, the restore coverage and the archiver's health (the CLI reads `pg_stat_archiver` and `pgbackrest info` inside the container over SSH; if the service is unreachable that section says "unavailable"). The target time must lie inside the coverage. Railway's documentation: base backups are a full one weekly and a differential daily, the last four fulls are kept (about four weeks), and the window begins at the first base backup after PITR was turned on. If the archiver is failing, or the target is outside the window, stop and use the logical backup.

## 3. Stop the damage if it is still happening

Only if the damage continues. Stopping `api`, `ctl` and `engine` means merchants see the app down and Shopify retries webhooks for up to 4 hours (ADR-178).

```sh
for service in api ctl engine; do
  railway down --service "$service" --environment "$ENV_NAME" --yes
done
```

`railway down` removes the service's most recent deployment. Bringing a service back is a deploy: run the `deploy.yml` workflow by hand from `main` with the current commit and image digests (step 8). `railway redeploy` after a `down` is not verified.

## 4. Restore into a sibling service

```sh
railway postgres pitr restore --service postgres --environment "$ENV_NAME" \
  --at 2026-10-19T14:07:00Z --new-service-name postgres-restore-<ticket-number>
```

`--at` takes RFC 3339, `YYYY-MM-DD HH:MM:SS` (your local time zone) or an offset such as `30m`. Without `--yes` it asks for confirmation; commands that prompt fail in non-interactive shells. Railway creates a new service with an empty volume at least as large as the source's, the same image and variables, and recovery variables set to the target time. **The source service is not touched.** Wait for it to become healthy (the dashboard shows the service; `railway logs --service postgres-restore-<ticket-number> --environment "$ENV_NAME"` shows PostgreSQL recovering). Record the start and end times: this is the PITR restore time.

The fork keeps the source's roles and passwords (a physical restore), so the `RAMPSMITH_DB_PASSWORD_*` shared variables still work against it. The fork does not archive: turn PITR on again after you rely on it (step 7).

## 5. Look at the fork through a tunnel

Never use a public database proxy (ADR-182 fails any deploy while one exists). In terminal A:

```sh
railway connect postgres-restore-<ticket-number> --environment "$ENV_NAME" --tunnel-only -P 55432
```

It prints Host, Port, User, Password and Database to the screen and holds the tunnel until Ctrl+C. In terminal B, with PostgreSQL 18 client programs installed:

```sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=<User as printed> PGDATABASE=<Database as printed>
read -rsp 'superuser password: ' PGPASSWORD; export PGPASSWORD; echo
read -rsp 'RAMPSMITH_DB_PASSWORD_API (from the vault): ' VERIFY_APP_PASSWORD; export VERIFY_APP_PASSWORD; echo
export PGBIN="$(pg_config --bindir)"
psql -c "select max(version) from _sqlx_migrations"
```

Write the schema version the production release carried at the target time (the newest file in `crates/db/migrations` of that release) and run the checks:

```sh
printf 'meta\tschema_version\t%s\n' 20261017000007 > expected.tsv     # use the real version
infra/restore-drill/verify.sh --expected expected.tsv --partial --min-tenants 1 --out ./verify-out
```

`verify.sh` takes the manifest of the fork, checks that the migration version matches, and checks through the `rampsmith_api` login that every tenant sees its own rows and no one else's, that a session without a tenant is refused and that a cross-tenant write is rejected. It prints `PASS` or `FAIL` lines and exits 1 on any failure. A passing run says the schema and the isolation survived; **it does not say the data you need is there**. Query for the rows the incident damaged and compare with what you know.

## 6. Choose the outcome

**A. Copy out (preferred when only some tables were damaged; no rename needed).**
Dump the needed tables from the fork and load them into the primary after review by a second person. For example, with the tunnel above:

```sh
pg_dump -Fc --data-only --table public.<table> -f copy-<table>.dump
```

then load into the primary through its own tunnel (`railway connect postgres --tunnel-only -P 55433`) inside one transaction, check the row counts, commit. No script exists for this: each incident differs. Delete the dump files afterwards.

**B. Cut over (when most of the data is wrong).** In the Railway dashboard: rename the source service `postgres` to `postgres-old-<date>`, then rename the fork to `postgres`. Then:

1. Run `deploy.yml` by hand from `main` (Actions > deploy > Run workflow) for the environment, with the current release commit and the image digests from that release's run summary. It re-applies the variables from the infrastructure code and brings back the services stopped in step 3.
2. **Prove the services use the new database.** The application logins must appear in the new database and be absent from the old one. In a tunnel to each: `select usename, count(*) from pg_stat_activity where usename like 'rampsmith_%' group by 1;`. If `rampsmith_api`, `rampsmith_ctl` and `rampsmith_engine` show only on the *old* database, Railway rewrote the references with the rename: swap the names back, stop, and use outcome A, or restore into a new database with the logical backup.
3. Never edit `DATABASE_URL` by hand in production: the infrastructure code reverts it on the next deploy.

## 7. After the restore

1. Turn archiving on for the new primary: `railway postgres pitr enable --service postgres --environment "$ENV_NAME"`, then check `pitr status`. Until its first base backup completes there is no point-in-time window on the new service.
2. `curl -fsS https://<app host>/readyz` (checks the database and the migration version). `railway logs --service api --environment "$ENV_NAME" --since 15m` shows no errors.
3. Expect side effects of going back in time, and tell the ticket which happened:
   - **Shopify tokens.** Refresh tokens rotate on every use (PLAN §14). A shop whose token rotated after the target time has a stale refresh token in the restored data; Shopify answers "revoked", `ctl` deletes the tokens (`shopify.token_revoked` in `audit_log`) and the merchant re-authenticates the next time they open the app. This counts against the SLO "Shops losing access because Rampsmith failed to refresh a token" (target 0); say so in the postmortem.
   - **Jobs.** Jobs that were `running` at the target time return to `ready` when their leases expire (the leader's reaper runs every 10 seconds).
   - **Lost events.** Webhooks received between the target time and the restore are gone from the database. Shopify retries failed deliveries for about 4 hours; for longer, reconcile ([webhook backlog](webhook-backlog.md)). GitHub redelivers only on request, within 3 days.
4. **Delete the fork when you no longer need it.** Its recovery variables hold a read and write credential for the source's archive bucket (Railway documentation), so a forgotten fork is a standing risk.
5. Close the tunnel (Ctrl+C), clear the terminal, delete `expected.tsv`, `verify-out/` and any dump files.

## Verify (done means)

- `verify.sh` printed only `PASS` lines and the rows the incident needed are present.
- The application logins are connected to the database that now holds the data.
- `pitr status` on the new primary shows PITR enabled.
- The ticket has the target time, the start and end of the restore, and who connected as the superuser.

## Rollback

Until the cutover the source is untouched: stop, delete the fork, and carry on with the source. After a cutover, the old service (`postgres-old-<date>`) is the rollback: rename the services back and re-run `deploy.yml`. Keep the old service until the incident is closed and a person has confirmed the data. Data written to the new primary since the cutover is not in the old one.

## Quarterly drill (PLAN §22)

Each quarter, in `staging`: run steps 2 to 7 against a point 30 minutes back, including a cutover by rename and the `pg_stat_activity` check, and record the elapsed time of each step in `docs/evidence/restore-drill-<year>-Q<n>.md`. The scripted logical drill (`.github/workflows/restore-drill.yml`) runs weekly without a person; this one cannot be scripted because it needs the Railway account.

## Escalation

- Archiver failing or restore stuck: Railway's status (<https://status.railway.com>), then a support request from the Railway dashboard. Which support channels the plan includes is not verified.
- Data loss beyond the PITR window or a lost project: [restore from logical backup](restore-from-logical-backup.md).
- Any suspicion that data was exposed: [incident response](incident-response-and-postmortem.md), SEV1.
