# WS-8 evidence: runbooks, nightly logical backup, restore drill

Stream branch `ws/ops`, pull request #13 (draft, "do not merge; stream CI") into `r0-foundations`.
LAUNCH.md B7 and PLAN §22. Written 19 October 2026. The builder session that owns `r0-foundations`
integrates this branch; the "Integration notes" and "Section E" below are for that reader.

## 1. What was built

All files are new and inside the stream's paths. Nothing outside them was edited, and
`docs/runbooks/shopify-dev-store.md` was not touched.

| Area | Files | What it does |
| --- | --- | --- |
| Nightly logical backup | `infra/backup/backup.sh`, `gate.sh`, `lib/common.sh`, `lib/s3.sh`, `backup-role.sql`, `r2/lifecycle.json`, `r2/bucket-lock.json` | `pg_dump -Fc` streamed into `age` (public recipients only), uploaded to the R2 backups bucket under a dated key, verified by size and SHA-256 read back, a monthly copy kept, pruned to 30 daily and 12 monthly periods (a limit stops a runaway prune), a metadata object as the commit marker. Two transports: `railway-ssh` and `url`. Exit codes 0 done, 1 failed, 3 skipped for missing inputs |
| Backup workflow | `.github/workflows/backup.yml` | Schedule (02:17 UTC) and `workflow_dispatch`; environments `backup-production` and `backup-staging`; `permissions: read-all` at the top and per-job grants; actions pinned by full SHA, image by digest; skips with a warning naming LAUNCH.md C rows 6 and 8 when inputs are absent |
| Restore drill | `infra/restore-drill/drill.sh`, `restore.sh`, `restore-local.sh`, `verify.sh`, `live.sh`, `list-backups.sh`, `lib.sh`, `in-container.sh`, `sql/*.sql` | Two fresh PostgreSQL 18 clusters: apply the repository migrations, seed two tenants, take a manifest, back up, restore into the second cluster, compare the manifest, prove row-level security still isolates the tenants, time it against the 4-hour (14,400,000 ms) target. `list-backups.sh` names the object to restore |
| Drill workflow | `.github/workflows/restore-drill.yml` | Jobs `lint` (ShellCheck at all severities, actionlint), `drill`, `backup-tests`, `live restore (staging)`. Runs weekly, on `workflow_dispatch`, and on pull requests that touch the paths. The live job skips with the C-row notice |
| Tests | `infra/backup/tests/run.sh`, `fake-aws.sh`, `fake-railway.sh`, `infra/restore-drill/tests/negative.sh`, `tests/runbook-sql.sh` | 156 backup assertions; 15 negative drill cases; 58 runbook-SQL checks |
| Runbooks | `docs/runbooks/README.md` and the nine runbooks (below) | Header (alert or SLO answered, severity, when to use, decisions, what was verified), built/not-built table, exact commands, verify, rollback, escalation |
| Runbook SQL | `docs/runbooks/sql/jobs-depth.sql`, `jobs-dead.sql`, `jobs-retry-dead.sql`, `jobs-token-state.sql`, `master-key-usage.sql`, `audit-window.sql` | The statements the runbooks tell an operator to run, executed by `runbook-sql.sh` |
| Decisions | `docs/adr/171` to `179` | Section 8 |

The nine runbooks: `restore-from-pitr.md`, `restore-from-logical-backup.md`, `rotate-token-master-key.md`,
`rotate-github-app-key.md`, `shopify-api-version-upgrade.md`, `dead-letter-triage.md`,
`webhook-backlog.md`, `ai-provider-outage.md`, `incident-response-and-postmortem.md`.

## 2. Version checks (CLAUDE.md: check on the live source, never from memory)

Checked on 19 October 2026 at implementation time (ADR-171 to ADR-176 cite the pages). On the final pass
this session could not query upstream release lists again (repository access is limited to
`billyribeiro-ux/rampsmith`), so these are the values from the earlier check, not a second check.

| Item | Pin | How it is pinned | Where |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c` | image index digest, the same one `ci.yml` uses | both workflows, `RD_IMAGE` |
| age | v1.3.2 | release asset SHA-256 `cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10`, checked with `sha256sum --check --strict` | both workflows |
| `actions/checkout` | v7.0.1 | full commit SHA `3d3c42e5aac5ba805825da76410c181273ba90b1` | both workflows |
| `actions/upload-artifact` | v7.0.2 | full commit SHA `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `restore-drill.yml` |
| ShellCheck | v0.11.0 | SHA-256 `8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198` | `restore-drill.yml` |
| actionlint | 1.7.12 | SHA-256 `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` | `restore-drill.yml` |
| Railway CLI | 5.70.0 | SHA-256 `f518230646acc7a6a7a67365e7642618f659d5d8cdd7cf8c180336140d0504eb` (ADR-185's pin) | `backup.yml` |
| Runner | `ubuntu-24.04`, AWS CLI 2.37.13 on the image | label, not a floating `latest` | both workflows |

Documentation read and cited in the ADRs: PostgreSQL 18 (`pg_dump`, `pg_restore`, continuous archiving
and PITR), the age specification and release notes (post-quantum recipients; a file cannot mix
post-quantum and classic recipients, which the gate checks), Cloudflare R2 (S3 API compatibility,
lifecycle rules, bucket locks, token scopes), Railway (variables and shared variables, deployments,
`railway postgres pitr`, the CLI reference, SSH, health checks), GitHub Actions (scheduled workflows,
environments, `permissions`), GitHub Apps (private keys, webhook deliveries), Shopify (API versioning,
webhooks), Anthropic (errors, Messages Batches). Docs beat PLAN.md in every conflict; each is a "Plan
correction" section in the ADR that found it (ADR-172, 175, 176, 177, 178, 179).

## 3. Commands and output

### Backup tests (local run on this branch, and CI)

```text
$ bash infra/backup/tests/run.sh
...
PASS	restore refuses an archive without metadata: exit 1
PASS	restore refuses an archive without metadata: says why
PASS	r2: the lifecycle cap is longer than the retention on all four prefixes
PASS	r2: the bucket lock is shorter than the retention on all four prefixes
PASS	r2: the lifecycle rules name the backup key layout
PASS	r2: the lock rules name the backup key layout
PASS	r2: a cap shorter than the retention is caught
PASS	r2: a lock longer than the retention is caught
backup-tests	156 passed, 0 failed
```

In CI the job `backup-tests` printed `150 passed, 0 failed` on run 39302841893 (head 0b6fd16); the six `r2:`
assertions were added after it, and the runs in section 4 for the later head report 156. The suite covers key names and
rejection of bad ones, retention (30 daily, 12 monthly, a limit on how much one run may delete, an
unfinished upload that never pushes out a good backup), the recipient list (public keys only, private
key refused without being echoed, a mixed post-quantum and classic list refused), the skip path (exit 3,
names C rows 6 and 8 and the missing variables), a round trip with two keys, the metadata object
(size, SHA-256, schema version, recipient fingerprint and no key), failure paths (killed `pg_dump`,
refused, truncated and corrupted uploads, corrupted read-back, a role without `BYPASSRLS`, an
application login) each leaving no metadata object, both transports with the database password and
the Railway token on no command line, and `list-backups.sh`.

### Restore drill (CI run 39302841893, job `drill`, head 0b6fd16)

```text
drill: postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2), age v1.3.2, repository migration 20261017000007, fault 'none'
manifest: 449 entries, 17 tables
dumped: 361116 bytes encrypted, 20 tables, 17 policies, schema 20261017000007
stored drill/daily/2026-10-19/rampsmith-drill-20261019T010203Z.dump.age (361116 bytes, sha256 334df15df1c90e15...)
fetched ...: 361116 bytes, sha256 matches the metadata
derived 120 expectations from the archive's table of contents
PASS	manifest	448 entries match the manifest written at dump time
PASS	schema-version	20261017000007 is the repository's newest migration
PASS	rls	24 table views across 2 tenants isolate through rampsmith_api; 24 had other tenants' rows to hide
PASS	rls	rampsmith_api without a tenant is refused
PASS	rls	a cross-tenant write is rejected by row-level security
rto	restore window 1360 ms, target 14400000 ms
PASS	rto	restore window 1 s is inside the 14400 s target
drill	PASS
```

| Stage | Time |
| --- | --- |
| provision-source | 823 ms |
| migrate-source | 121 ms |
| seed | 127 ms |
| manifest | 43 ms |
| backup | 187 ms |
| restore-window (fetch 14, decrypt 3, list 13, target 33, restore 84, analyze 69; total including verification) | 1054 ms |
| damage | 1 ms |
| verify | 303 ms |
| **RTO: restore window against target** | **1360 ms against 14,400,000 ms** |
| restore-local on the drill's own archive (the substitute for the live path) | 223 ms of restore after 829 ms of provisioning; 1206 ms window |

These are the times on a 361 KB fixture and say nothing about a production-sized database: the
measurement the 4-hour target needs is a Section E row.

### Negative cases (the drill must fail on each, and must name the fault)

Run 39302841893, step "Negative cases": `negative	15 cases, 0 failed`.

```text
PASS	control	the unmodified drill passes
PASS	tamper-manifest-checksum	the drill failed (exit 1) and named the fault
PASS	tamper-data	...
PASS	drop-policy	...
PASS	disable-rls	...
PASS	drop-table	...
PASS	truncate-table	...
PASS	drop-grant	...
PASS	stale-backup	...
PASS	corrupt-ciphertext	...
PASS	wrong-key	...
PASS	skip-bootstrap	...
PASS	nonempty-target	...
PASS	no-bypassrls	...
PASS	rto-exceeded	...
```

(Each line after the first reads "the drill failed (exit 1) and named the fault" in the log.)

### Skip notices as they appear on a real runner (run 39302841893, job `backup-tests`)

```text
##[warning]backup of staging skipped: needs R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS BACKUP_AGE_RECIPIENTS BACKUP_DB_NAME BACKUP_DB_PASSWORD RAILWAY_API_TOKEN BACKUP_RAILWAY_PROJECT_ID BACKUP_RAILWAY_ENVIRONMENT BACKUP_RAILWAY_SERVICE BACKUP_RAILWAY_SSH_PRIVATE_KEY (LAUNCH.md section C rows 6 and 8); nothing was backed up
configured=false
##[warning]live restore drill skipped: needs R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS BACKUP_DRILL_AGE_KEY (LAUNCH.md section C rows 6 and 8); the substitute test, the same restore path on the drill's own archive, ran in this workflow
```

### Runbook SQL (local run, 58 checks, and CI step "Runbook SQL")

```text
$ bash infra/restore-drill/tests/runbook-sql.sh
...
PASS	audit-window says what is missing
runbook-sql	58 checks, 0 failed
```

Sample output of each file against the seeded database (two tenants, jobs in every state):

```text
jobs-depth.sql           shopify.token_refresh  dead   2
                         shopify.token_refresh  ready  1   600.0   (oldest ready, seconds)
                         webhook.process        dead   1
jobs-dead.sql            shopify.token_refresh  crypto            1   ...
                         22222222-...  shopify.token_refresh  aaaaaaaa-...  1  8  ...  crypto  unknown key id
jobs-retry-dead.sql      retried (1 = made ready ...) and audited (1 = logged)
                         1	1
master-key-usage.sql     k20260101	1
                         k20261019	1
jobs-token-state.sql     64c9c361-...	installed	k20261019	2026-10-02 ...	2027-01-01 ...	73.2	dead	shopify_unavailable
audit-window.sql         fix.proposed	system	240	2
                         job.retried	operator	2	2
                         tenants with any audit row in the window: 2
                         2026-10-19 18:29:50+00  aaaaaaaa-...  tester  job.retried
```

Refusals are tested too: the superuser-only files refuse `rampsmith_ctl` and `rampsmith_api` with
"needs a role that bypasses row-level security" and print no counts; `jobs-retry-dead.sql` refuses
without a job id or an operator name and changes nothing; a retried job is `ready` with a fresh budget
and one `audit_log` row (actor kind `operator`) names the operator, job, tenant and reason; a second
retry, or a job that is not dead, changes and logs nothing; no file prints a payload or the `data`
column.

### Lint

```text
$ shellcheck -x -P SCRIPTDIR infra/backup/*.sh infra/backup/lib/*.sh infra/backup/tests/*.sh \
      infra/restore-drill/*.sh infra/restore-drill/tests/*.sh
(no output; exit 0)
$ actionlint -shellcheck=shellcheck .github/workflows/backup.yml .github/workflows/restore-drill.yml
(no output; exit 0)
```

CI repeats both on every run (`lint` job: ShellCheck at all severities, actionlint with ShellCheck on the
workflow scripts). Relative links across the runbooks and ADRs 171 to 179 were checked: 20 files, 0 broken.

## 4. CI runs

Pull request #13: <https://github.com/billyribeiro-ux/rampsmith/pull/13>.

| Head | `restore-drill` | `ci` |
| --- | --- | --- |
| `fbc5f7a` backup and drill workflows | [39292515273](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39292515273) success | [39292515186](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39292515186) success |
| `d5c39da` post-quantum recipient gate | [39296924492](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39296924492) success | [39296924447](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39296924447) success |
| `7f9c871` ADR-171 to 176 | [39298279077](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39298279077) success | [39298279312](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39298279312) success |
| `1897d55` runbook SQL, ADR-177 | [39300052033](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39300052033) success | [39300052035](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39300052035) success |
| `9fb9758` list-backups, ADR-178, 179 | [39301423151](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39301423151) success | [39301422880](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39301422880) success |
| `0b6fd16` eight runbooks | [39302841893](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39302841893) success | [39302841858](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39302841858) success |
| `d482001` incident runbook, index, audit-window (58 runbook-SQL checks) | [39303834178](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39303834178) success | [39303834332](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39303834332) success (8 jobs: rust, node, contracts, e2e, four images) |

The head after `d482001` adds this file, the R2 file tests (156 backup assertions) and ADR-172's note on
them. Its runs are the checks on pull request #13 and are named in the stream's hand-back; a file
cannot name the CI run of the commit that contains it.

The job `live restore (staging)` is `skipped` in every run, as designed (no secrets; Section E).
Earlier heads include two that were fixed within the stream's paths (the drill role fixtures; the
mixed post-quantum recipient list). No failure was outside the stream's paths.

## 5. Acceptance (the work order's list)

| Item | State |
| --- | --- |
| CI green on the PR head, including the restore drill | Met on every head through `d482001` (section 4); the final head's runs are in the hand-back |
| actionlint and ShellCheck clean | Met (local and the `lint` job) |
| The drill fails on each negative case and tests prove it | Met: 15 cases, 0 failed |
| Nine runbooks present, accurate to the code | Met as to the code on the branches listed in each runbook; every piece that does not exist is marked "not built" (README, "Not built") |
| Backup workflow skips with the C-row notice when secrets are absent | Met: shown above, on a real runner |
| Evidence file complete | This file |
| Security-auditor review at `max` | **Owed**, section 10 |

## 6. ADRs

| ADR | Decision |
| --- | --- |
| 171 | The nightly logical backup: what it is, how it is taken, what it records |
| 172 | Storage in R2: layout, verification, retention, lifecycle and locks |
| 173 | Encryption with age, the recipient list, key custody |
| 174 | The backup workflow: environments, schedule, the two transports, the skip path |
| 175 | The scripted restore drill: stages, manifest, RLS check, RTO, negative cases |
| 176 | Restore procedures: PITR and logical, which to use, cutover |
| 177 | Key rotation runbooks: the master key ring, the GitHub App key and webhook secret |
| 178 | The operational runbooks: dead-letter triage, webhook backlog, API version upgrade, AI outage; the SQL and its test |
| 179 | Incident response, the alert-to-runbook map, the signals this build still lacks |

Plan corrections (each in the ADR's "Plan correction" section; the integrator applies them to PLAN.md,
which this stream may not edit): PLAN §22 (what the layers are and what survives which loss; the
secrets row, "before each rotation is deployed"), PLAN §21 (two backup alerts; the dead-job rule), and
PLAN §24 (the quarterly drill).

## 7. Findings worth the integrator's attention

These came out of reading the code for the runbooks. None is fixed here because each is in another
stream's paths.

1. **The retry budget is shorter than an outage.** A job's retries (5 s doubling, capped at one hour,
   jittered, 8 attempts) are spent in 5 to 11 minutes. A Shopify or database outage longer than that
   kills the jobs it touches, including the weekly `shopify.token_refresh` chain whose death is the
   one SLO with target 0. Dead-letter triage handles it by hand; a longer budget for that queue
   belongs to the queue owner.
2. **No dead-job signal.** A job that uses up retryable attempts is counted `retryable` and still
   dies; only the log line `job is dead` and the database see it. The first PLAN §21 page needs a log
   rule today and a metric later.
3. **None of the twelve alerts has a rule in the repository**, and most signals are not built (README
   table). The runbooks say which.
4. **The master-key rollout has one known window** (a new `api` may seal under the new key before the
   old `ctl` restarts). `rsctl keys rotate` always puts the new key first; a staging mode that adds it
   last would remove the window.
5. **`ctl`'s configuration does not read `GITHUB_APP_PRIVATE_KEY`** yet, and the previous-webhook-secret
   path (`WebhookVerifier::with_previous`) is not wired to an environment variable.
6. **The R2 lifecycle cap and the bucket locks are applied by the founder** (a bucket token cannot);
   until they are, retention is by count only. The locks are worth applying at once; the lifecycle cap
   only after a backup-freshness alert exists, because an age rule keeps deleting if the nightly job
   silently stops (ADR-172, decision 6). A test checks that both files agree with the 30 and 12 period
   retention, so an edit that shortens a cap or lengthens a lock fails the pull request.
7. **`railway-ssh` transport**: the Railway workspace token it needs can do more than the backup; ADR-174
   records the blast radius and the alternative (a Railway cron service that dumps from inside the
   private network).

## 8. Integration notes (anything outside the stream's paths that must change)

For `docs/LAUNCH.md`:

- Section C rows 6 and 8 should list what the backup adds: `BACKUP_AGE_RECIPIENTS` (public keys; two or
  more, one held offline), `BACKUP_DRILL_AGE_KEY` (a staging-only private key, secret of `backup-staging`
  only), `BACKUP_RAILWAY_SSH_PRIVATE_KEY`, `RAILWAY_API_TOKEN` (workspace token, for the `railway-ssh`
  transport), the `rampsmith_backup` password (`BACKUP_DB_PASSWORD`, role in `infra/backup/backup-role.sql`:
  read-only, `BYPASSRLS`), the R2 token scoped to the backups bucket only (separate from the evidence
  bucket's), and the two GitHub environments `backup-production` and `backup-staging` (restricted to
  `main`, with **no** required reviewers, or scheduled runs will wait).
- Section C should say where the offline private age keys are kept (ADR-173). The founder applies
  `infra/backup/r2/bucket-lock.json` in the Cloudflare dashboard once the backups bucket exists, and
  `lifecycle.json` only after a backup-freshness alert is live (ADR-172, decision 6).
- Name the second person for break-glass access (PLAN §18), or record the decision that the incident
  ticket is the substitute until then (ADR-179).
- Section E: the rows in section 9 below.

For `docs/adr/README.md`: rows for ADR-171 to ADR-179 (this stream may not edit the index).

For `docs/PLAN.md`: the corrections listed in section 6.

For other streams:

| Owner | Needed |
| --- | --- |
| `ws/rsctl` | `rsctl jobs list`, `retry`, `depth` (the SQL files stand in; the comment on `queue::retry_dead` already names `rsctl jobs retry`); a staging mode for `keys rotate`; a re-wrap job using `KeyRing::rewrap`; a forced token-refresh for all shops |
| `crates/queue` and `ctl` | Export `queue::depth` and the age of the oldest ready job; count dead jobs as a metric; a longer retry budget for `shopify.token_refresh`; the `job is dead` log line stays until then |
| `crates/api` | Webhook intake with the second listener, the `webhook_events` table, the unique event id, counters for received, acknowledged and signature-failed, a previous-secret variable, a reconciliation job (Shopify's documented advice), the compliance-topic handlers |
| `engine` and `@rampsmith/ai` | The ai worker that stops claiming while the breaker is open, a breaker-state metric, `BudgetLedger` on PostgreSQL, `ai_calls`, a spend metric |
| `@rampsmith/email` | The SES adapter, the `email.send` job, a recipient query for an incident notice to all affected merchants |
| `ws/deploy` | `infra/restore-drill/sql/roles.sql` is a fixture twin of `infra/railway/bootstrap.sql` and must follow it when logins are added (ADR-175; a check that they match is not built); the `deploy.yml` rollback path the runbooks cite (ADR-185); the collector's R2 log archive (ADR-184) |
| Telemetry and Grafana (founder, C row 9) | Alert rules for the twelve alerts and the burn-rate rule; the two backup alerts and an independent monitor for "the nightly job did not run" (ADR-179); the synthetic journey |
| Scheduling | `backup.yml` and the weekly drill run from the default branch only, so they start after the release branch merges to `main`; GitHub disables scheduled workflows after 60 days without repository activity |

## 9. Section E (live checks that need a founder input)

Each row has a substitute test that passes now, a live step that skips with a notice naming the C row,
and the command that runs it live. A row stays until the live run passes.

| Live check | C rows | Substitute test now | Live command |
| --- | --- | --- | --- |
| Nightly backup to the real R2 bucket: upload, read-back size and SHA-256, monthly copy, retention | 6, 8 | `infra/backup/tests/run.sh` (156 assertions) against a fake `aws`; the drill's `url` transport against a local directory store | Run the `backup` workflow (`workflow_dispatch`, environment `staging`); then `infra/restore-drill/list-backups.sh --environment staging` |
| `railway-ssh` transport: `pg_dump` run on the database service over Railway's SSH, no database password on a command line | 8 | `fake-railway.sh` checks the command line, the environment and the output | The same workflow with the SSH transport variables set |
| Weekly live restore of the newest staging backup into a clean database, with the manifest, RLS and RTO checks | 6, 8 | `restore-local.sh` on the drill's own archive (runs in every drill) | The `restore-drill` workflow (`workflow_dispatch`) with `BACKUP_DRILL_AGE_KEY` set; or `infra/restore-drill/live.sh --environment staging` |
| Restore of a **production** backup by a person, timed against 4 hours (also the quarterly drill) | 6, 8 and the offline age key | The drill and `restore-local.sh` on a fixture; `restore.sh` negative cases | `docs/runbooks/restore-from-logical-backup.md`, steps 1 to 6; record the times in the ticket |
| PITR: `railway postgres pitr status`, restore into a sibling service, look through a tunnel, cutover | 8 | None possible (a Railway feature); the verify script of the drill runs against the fork | `docs/runbooks/restore-from-pitr.md`, steps 2 to 7; rehearse in `staging` first |
| PITR cutover by renaming services (what happens to `${{postgres.…}}` references and the private name) | 8 | None | Rehearse in `staging`; the runbook's decision table says what to do if it does not work |
| Applying the lifecycle rule and the bucket lock; checking that R2's checksum defaults do not break the read-back | 6 | Six assertions in `infra/backup/tests/run.sh`: both files agree with the retention and the key layout, and a too-short cap and a too-long lock are caught; the read-back is tested against the fake | Founder applies `bucket-lock.json` (and `lifecycle.json` after the freshness alert exists) in the Cloudflare dashboard; then the backup workflow |
| The runbook SQL on a real Railway database (`railway connect postgres --ssh`) | 8 | `runbook-sql.sh` on a local PostgreSQL 18 with the repository migrations | Run `jobs-depth.sql` and `jobs-dead.sql` in a break-glass session on `staging`; record it |
| Master-key rotation end to end on staging with a development store: new ring, deploy, a real refresh opens an old value and seals a new one, `master-key-usage.sql` shows the new id | 1, 3, 8, 12 | `rsctl doctor --row 12` round trip (no network) and the `rsctl keys` tests; `master-key-usage.sql` tests | `docs/runbooks/rotate-token-master-key.md`, steps 1 to 7 on `staging` |
| GitHub App key rotation: new key, `rsctl doctor --row 4` passes with it, old key deleted | 4, 8 | The `ws/github-app` JWT tests; the fingerprint step | `docs/runbooks/rotate-github-app-key.md`, Part 1, on the test App |
| GitHub webhook secret rotation and redelivery | 4 | `WebhookVerifier` tests (`ws/github-app`) | Part 2 of the same runbook |
| Shopify API version header: the version served is the version asked for | 1, 3 | The `crates/shopify` tests on recorded responses | `docs/runbooks/shopify-api-version-upgrade.md`, step 5 |
| AI outage steps: `rsctl doctor --row 5`, orphan batch listing and cancel | 5 | `@rampsmith/ai` tests (359, recorded responses) | `docs/runbooks/ai-provider-outage.md`, steps 1 and 4, with a test key |
| Incident tabletop: a made-up SEV1 from declaration to the draft notice, timed | 13 (attorney review of the notice text) | The template and the claims checklist are in the runbook | `docs/runbooks/incident-response-and-postmortem.md`, "Practice" |

## 10. Security-auditor review owed

CLAUDE.md requires the `security-auditor` subagent at `max` for every change to auth, tokens, webhooks,
`egress`, encryption or row-level security. This stream's stream rules forbid subagents, so **the review
has not been done and is owed before this branch's release gate**. What to read, in order of risk:

1. `infra/backup/backup-role.sql` and the `rampsmith_backup` login: a read-only role with `BYPASSRLS`
   reads every tenant by design, and the backup tests prove it is refused when the role lacks it.
2. The `railway-ssh` transport and the workspace token it needs (ADR-174, blast radius).
3. Key custody: public recipients only in CI; the private age key never in CI; the staging drill key
   is a different key (ADR-173); the refusal of a private key in the recipient list without echoing it.
4. The SQL break-glass files: `jobs-retry-dead.sql` writes to `audit_log` and changes a job; three files
   need the superuser and refuse other roles; none prints a payload, a token or the `data` column.
5. The master-key and GitHub App key rotation procedures (ADR-177): vault as the only source of the
   ring, staging first, no secret in argv.
6. Workflow permissions: `permissions: read-all` or `{}` at the top, per-job grants, the backup
   environments' secrets, `persist-credentials: false`, all actions pinned by SHA.
7. The RLS check in the drill (24 table views across two tenants; a cross-tenant write is rejected; no
   tenant set is refused).
