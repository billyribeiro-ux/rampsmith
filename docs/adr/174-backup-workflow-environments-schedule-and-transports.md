# ADR-174: The backup workflow: environments, schedule, the skip gate and how the job reaches the database

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`.github/workflows/backup.yml`, `infra/backup/gate.sh`)
- Refines: PLAN §22 and §24; CLAUDE.md ("skips ... with a notice naming the input"); LAUNCH.md B7 and
  section E; ADR-182, ADR-183, ADR-185

## Context

The nightly backup has to run unattended, hold credentials that nothing else holds, and say so when it
cannot run. GitHub Actions documentation, read on 19 Oct 2026 from the `github/docs` repository
(`content/actions/…`; docs.github.com is not reachable from the sandbox):

- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments):
  "Secrets stored in an environment are only available to workflow jobs that reference the
  environment. If the environment requires approval, a job cannot access environment secrets until one
  of the required reviewers approves it." Deployment branches can be limited to chosen branches.
- [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments):
  "Running a workflow that references an environment that does not exist will create an environment
  with the referenced name" (without protection rules).
- [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):
  "Scheduled workflows will only run on the default branch" (`GITHUB_SHA` is the last commit there);
  the `schedule` event "can be delayed during periods of high loads ... some queued jobs may be
  dropped"; "In a public repository, scheduled workflows are automatically disabled when no repository
  activity has occurred in 60 days"; `workflow_dispatch`'s "Run workflow" button exists only when the
  workflow file is on the default branch.
- [Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) and
  [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax):
  "Secrets cannot be directly referenced in `if:` conditionals"; an unset secret evaluates to an empty
  string; `jobs.<job_id>.if` sees `github, needs, vars, inputs` only.

PLAN §24 gives `staging` and `production` the founder as required reviewer (LAUNCH.md C row 14).
ADR-182 and ADR-183 keep the database off the internet: no TCP proxy, `ensure_network.py` fails any
deploy while one exists. A GitHub-hosted runner therefore cannot open a connection to the database.
Railway documents what can: `railway connect postgres --tunnel-only` (an SSH tunnel to the container,
holding a port open until interrupted) and `railway ssh -- <command>` (a command inside the service
container, "piped input runs without a PTY so output stays clean for scripts and CI";
<https://docs.railway.com/cli/ssh>, <https://docs.railway.com/cli/connect>). The same page says SSH key
management "isn't supported with project tokens (`RAILWAY_TOKEN`); use a workspace API token", and
"workspace keys grant SSH access to every service in the workspace".

## Decision

1. **Two environments of its own: `backup-production` and `backup-staging`.** This deviates from the
   task text, which named `production`. A required reviewer on `production` would hold every scheduled
   run until someone clicked, and an unattended nightly job that waits for a human is a missed backup.
   The `backup-*` environments must have no required reviewers, a deployment-branch rule limiting them
   to `main` (the only branch scheduled runs use), and hold only the backup's secrets: R2 credentials
   for one bucket, the backup database password, the Railway workspace token and SSH key, and
   (staging only) the drill key. The founder creates them with those rules *before* adding secrets,
   because the first run would otherwise create them unprotected (the second quotation above).
2. **The schedule** is `17 2 * * *` UTC, off the hour because GitHub says the top of the hour is when
   delays and drops happen, plus `workflow_dispatch` with an `all | production | staging` input. A
   `plan` job turns the choice into a matrix; `backup (production)` and `backup (staging)` run in
   parallel, each with its own `concurrency` group (`cancel-in-progress: false`) so two runs of one
   environment never overlap.
3. **Permissions.** `permissions: read-all` at the top, `contents: read` on the one job that needs it,
   `{}` on `plan`. Actions are pinned by full commit SHA (`actions/checkout` v7.0.1 `3d3c42e5…`;
   `actions/upload-artifact` v7.0.2 `cf430e03…` in the drill workflow), the PostgreSQL image by
   digest, `age` and the Railway CLI by release asset SHA-256 (the Railway pin is ADR-185's, CLI
   5.70.0), ShellCheck 0.11.0 and actionlint 1.7.12 by SHA-256. The runner is `ubuntu-24.04`, which
   ships AWS CLI 2.37.13 (ADR-172).
4. **The gate never fails silently and never fails red for a missing input.** Because `secrets` cannot
   appear in `if:`, the first step maps the environment's secrets and variables into its own `env` and
   runs `infra/backup/gate.sh`. When anything the chosen transport needs is empty it writes
   `::warning::backup of <env> skipped: needs <names> (LAUNCH.md section C rows 6 and 8); nothing was
   backed up`, adds the same text to the job summary, sets `configured=false` and exits 0; every later
   step is conditional on `configured == 'true'`. The same exit-code-3 path inside `backup.sh` turns
   into the same warning. The tests assert the annotation text, that it names only what is missing,
   and that a half-configured environment skips (`infra/backup/tests/run.sh`); the `backup-tests`
   job of `restore-drill.yml` runs the gate on every pull request, so the annotation is visible on a
   real runner. A skipped backup is never a pass: the job's conclusion is "success" with a warning,
   and the freshness alert (ADR-179) is what catches a pipeline that skips forever.
5. **Two transports, `BACKUP_SOURCE`.**
   - `railway-ssh` (the default): `railway ssh -p -e -s … -- sh -c 'IFS= read -r PGPASSWORD; export
     PGPASSWORD; exec "$@"' sh pg_dump -h … -U … -d … -Fc`. The database password travels on standard
     input, so it is on no command line either side; the Railway CLI quotes the arguments. The dump
     runs inside the database container with the server's own `pg_dump`, and the encrypted stream
     arrives on the runner's standard output. Credentials: a *workspace* `RAILWAY_API_TOKEN`
     (LAUNCH.md C row 8, the optional workspace token) and a private SSH key registered as a
     workspace key.
   - `url`: libpq environment variables to a host the runner can reach (a tunnel, a self-hosted
     runner on the private network, or a test cluster). It is what the tests and the drill use.
6. **The known cost of `railway-ssh`.** A workspace token plus a workspace SSH key grant a shell in
   *every* service of the workspace, including `api` and `ctl`, which hold the master key ring and the
   GitHub App key. That is far more than a backup needs, and it sits in a GitHub environment. The
   mitigations are structural: the environment is limited to `main`, which is protected (C row 14) and
   changes only by reviewed pull request; the workspace should contain Rampsmith only; the key is
   dedicated to the backup and removable (`railway ssh keys remove`); and the token can be revoked.
   They do not remove the risk. The better design is a Railway cron service inside the project that
   runs these scripts on the private network and holds only R2 credentials and the public recipients
   (<https://docs.railway.com/cron-jobs>: a service started on a schedule must exit when done). It
   needs a service image and IaC change, which are the deploy stream's files (`infra/railway/`), so it
   is an integration note and not built here. Until it exists the security-auditor review at `max`
   (CLAUDE.md) should decide whether `railway-ssh` ships.
7. **Not verified live (Section E).** `railway ssh` carrying a multi-gigabyte binary stream; that a
   workspace token and workspace key authorise it from a runner; that `-e` and `-s` select the
   environment and service as the CLI help says. The substitute tests use a stand-in that applies the
   same argument contract and assert that no password and no token reaches any command line.
8. **Scheduled workflows need the default branch.** `backup.yml` cannot run, nor be dispatched, until it
   is on `main` (the events quotation above). On this branch only the `restore-drill` workflow runs. After
   merge the first action is a manual `workflow_dispatch` to `staging`; the 60-day inactivity rule is
   met by the repository's ordinary activity and, if it ever lapses, by the freshness alert.

## Consequences

- With none of the C rows 6 and 8 inputs the workflow is green with two warning annotations a day.
- `BACKUP_SOURCE` is a variable, so the transport changes without a code change; a Railway cron service
  would be a third value of the same variable.
- The backup's credentials never live in the `production` environment, where a deployment approval and
  a Railway deploy token are; a deployment approval cannot trigger a backup and a backup cannot deploy.
- The founder's setup list grows (integration note): the two environments and their rules, the R2
  token, the `rampsmith_backup` password (`infra/backup/backup-role.sql`), the workspace token and SSH
  key, `BACKUP_AGE_RECIPIENTS`, and `BACKUP_DRILL_AGE_KEY`.

## Rejected alternatives

- Using `production` and `staging` as the environments: the required reviewer blocks scheduled runs.
- A public TCP proxy or a database firewall allow-list for GitHub's address ranges: ADR-182's rule, and
  those ranges are shared and change.
- `railway connect postgres --tunnel-only` in CI: it prints the superuser password to standard error
  (`print_tunnel_info` in the pinned CLI) and holds a port open for a human to interrupt; usable by
  hand (the runbooks do), not as an unattended step.
- A repository-level `if: secrets.X != ''`: not allowed by the syntax; the gate script is the supported
  pattern.
- Failing red when unconfigured: the founder's accounts come last (CLAUDE.md); a red nightly for weeks
  teaches everyone to ignore red.
