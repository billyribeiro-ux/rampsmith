# WS-9 evidence: deployment as configuration

- Stream: WS-9 (PLAN §22, §24; LAUNCH.md B "Deployment as configuration")
- Branch: `ws/deploy`, from `r0-foundations` at `16926b5`; draft PR #7 into `r0-foundations`
  ("do not merge; stream CI")
- Owns: `infra/railway/`, `infra/collector/`, `.github/workflows/release.yml`,
  `.github/workflows/deploy.yml`; ADRs 181–189 (181–185 used)
- Dates: 17–18 Oct 2026

## What was built

| Path | What it is |
| --- | --- |
| `infra/railway/railway.py` | Railway infrastructure as code (Python, `railway-sdk` 0.7.0): `web`, `api`, `ctl`, `engine`, `egress`, `collector` and PostgreSQL 18 for `staging`, `production` and `preview` (the base of PR environments). Health checks (`/readyz` for api, `/healthz` for the rest) on `PORT`, the api's `sqlx migrate run` pre-deploy step as `rampsmith_migrator`, one replica each in `us-east4-eqdc4a`, every secret a reference to a Railway shared variable used only by the services that need it (ADR-181, ADR-182, ADR-183) |
| `infra/railway/bootstrap.sql` | Creates the migration role and one login per service, once per environment, over `railway connect postgres --ssh` (ADR-183) |
| `infra/railway/scripts/railway_plan.py` | Reads a `railway config plan --json` result: what runs now, the inputs and expected images of each deploy phase, and the check that refuses a plan before it is applied (ADR-185) |
| `infra/railway/scripts/wait_for_deployment.py` | Waits until a service runs an exact digest in a deployment created after the apply (ADR-185) |
| `infra/railway/scripts/ensure_network.py` | Holds public exposure to the `PUBLIC` list: registers missing custom domains, corrects target ports, fails on any Railway domain, TCP proxy or unlisted domain (ADR-182) |
| `infra/railway/scripts/check_protection.py` | Refuses a deploy unless its GitHub environment allows only `main` and, for production, requires a reviewer (ADR-185) |
| `infra/railway/scripts/node_lts_guard.py` | Refuses a deploy while `.mise.toml` (or an image) pins a Node.js release whose `process.release.lts` is empty, or one outside the 26.x line (CLAUDE.md, ADR-016) |
| `infra/railway/scripts/service_spec.py` | Prints a service's port, health check and commands from `railway.py`, for the image smoke test |
| `infra/railway/tools/` | `install_railway_cli.sh` and `railway-cli.sha256` (Railway CLI 5.70.0 release tarball, SHA-256 pinned); `shopify-cli/` (`@shopify/cli` 4.9.4 with a committed lockfile) |
| `infra/railway/requirements.txt`, `requirements-ci.txt` | `railway-sdk` and `shellcheck-py`, hash-pinned |
| `infra/railway/tests/` | `test_railway.py` and `test_scripts.py` (69 unit tests), `cli_eval_python.py` (the CLI's own evaluator, copied), `bootstrap_test.sh` (PostgreSQL), `image_smoke.sh` (each image started as Railway starts it) |
| `infra/collector/config.yaml` | OpenTelemetry Collector: OTLP/HTTP in with a bearer token, scrubbing, Grafana Cloud out, logs archived to R2 (ADR-184) |
| `infra/collector/tests/smoke.py` | Validates the config with the pinned image and runs it end to end against a fake Grafana gateway and a fake path-style S3 |
| `.github/workflows/release.yml` | Push to `main`: build once, push, sign provenance (`publish`); verify, SBOM, scan, smoke-test read-only (`verify`); staging, then production. Pull requests: the same checks as a dry run |
| `.github/workflows/deploy.yml` | `check` (no secret), `railway` (Railway token only), `shopify` (Shopify token only), `smoke` (no secret); every founder input missing is a named skip |

## Commands run and their output

Local (this session, Linux x86_64):

| Command | Result |
| --- | --- |
| `python -m unittest discover -s infra/railway/tests` (Python 3.13, `railway-sdk` 0.7.0) | `Ran 69 tests ... OK`, including the CLI 5.70.0 evaluator run on `railway.py` |
| `PGHOST=127.0.0.1 PGPORT=55432 bash infra/railway/tests/bootstrap_test.sh` (PostgreSQL 18.4, migrations applied with psql because `sqlx` was not on PATH locally) | refusals 1/1, logins, migrations, privileges, row-level security, workers, rotation: `bootstrap test: PASS` |
| `actionlint` v1.7.12 (built from source with Go 1.27.2) on both workflows, shellcheck 0.11.0 on PATH | no findings |
| `shellcheck infra/railway/tests/*.sh infra/railway/tools/*.sh` (0.11.0) | no findings |
| `prettier --check` on both workflows, `infra/collector/config.yaml`, the ADRs; `eslint .`; `knip` | clean (knip first flagged `shopify` as an unlisted binary; the workflows now call it through a variable) |
| `bash infra/railway/tools/install_railway_cli.sh <dir>` | `railway-v5.70.0-x86_64-unknown-linux-musl.tar.gz: OK`, `railway 5.70.0` |
| `npm ci --ignore-scripts` in `infra/railway/tools/shopify-cli`, then `shopify version` | `4.9.4` |
| `pip install --require-hashes -r infra/railway/requirements.txt -r infra/railway/requirements-ci.txt` | installs; `shellcheck --version` 0.11.0 |

`mise run verify` was not run end to end locally (the session has no Rust 1.99.1 toolchain);
the stream's files are covered by the commands above and by `ci.yml` on the pull request.

CI on draft PR #7 (`release.yml` dry run and `ci.yml`):

| Run | Commit | Result |
| --- | --- | --- |
| [39088436582](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39088436582) | `fa325a9` | `startup_failure`: the called workflow asked for more permissions than its caller (fixed in `33534e4`) |
| [39088737207](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39088737207) | `33534e4` | collector digest read from GHCR and Docker Hub (identical), then pinned |
| [39088925433](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39088925433) / [39088925438](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39088925438) | `193b2f1` | release failed in the collector smoke test (archive key encoding, fixed in `6eb19b9`); ci success |
| [39092884913](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39092884913) / [39092884844](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39092884844) | `77a751e` | `deploy config` passed (unit tests, actionlint, shellcheck, the Railway CLI pin matched GitHub's asset digest, the Shopify lockfile, the LTS guard refused 26.12.0 and held the 26 line against a real 24.22.0 binary); collector failed as above |
| [39093283782](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39093283782) / [39093283794](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39093283794) | `af2100e` | release success (collector smoke passed with the bearer token and the scrub checks) and ci success |
| [39096492374](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39096492374) | `afe6e76` | `deploy config` and `collector config` passed with the second review's fixes (75 unit tests at the next commit); BuildKit digest read for the pin |
| final rows | see "Final state" | |

## Pins

| Thing | Pin | Checked against |
| --- | --- | --- |
| Railway CLI | 5.70.0, `railway-v5.70.0-x86_64-unknown-linux-musl.tar.gz` SHA-256 `f518230646acc7a6a7a67365e7642618f659d5d8cdd7cf8c180336140d0504eb` | downloaded and hashed here; `release.yml` compares it with GitHub's recorded asset digest on every run (passed in run 39092884913); the CLI's source read from the `railwayapp` 5.70.0 crate (checksum `419e90a9…5e24a`) |
| `railway-sdk` | 0.7.0, `sha256:2cabab22…b06c` | PyPI |
| `shellcheck-py` | 0.11.0.1, `sha256:1b274df8…ef05` (manylinux x86_64 wheel) | PyPI, wheel hashed here |
| `@shopify/cli` | 4.9.4 (lockfile v3, `npm ci --ignore-scripts`) | npm registry |
| OpenTelemetry Collector contrib | 0.163.1, `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:1175b03003053962012f5a231f5567f66a3e8fdb960c7835c0e48f7aa1555806` | GHCR and Docker Hub index digests (run 39088737207) |
| PostgreSQL on Railway | `ghcr.io/railwayapp-templates/postgres-ssl:18` (major tag, the one unpinned image: PITR requires it, ADR-183) | `railway-sdk` 0.7.0 `postgres()` |
| BuildKit daemon | `moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c` | Docker Hub index digest read by `release.yml` run 39096492374 (18 Oct 2026); v0.34.0 released 7 Oct 2026, past Renovate's 7-day minimum age |
| PostgreSQL in CI | `postgres:18.6-bookworm@sha256:afc7e2d4…a647c` | same as `ci.yml` |
| actionlint | v1.7.12 via `go install` (sum.golang.org); Go 1.27.2 | newest tag |
| Python, mise | 3.15.0 (`actions/setup-python`), mise 2026.10.12 | same as `ci.yml` |
| Actions | every `uses:` by full commit SHA, tag in the comment (ADR-185 table) | `git ls-remote` of each repository |

## Decisions (ADRs)

- [ADR-181](../adr/181-railway-infrastructure-as-code.md): Railway services as infrastructure as
  code, in Python; pinned CLI; pinned plans.
- [ADR-182](../adr/182-service-topology-and-variables.md): service topology, network exposure
  and variables.
- [ADR-183](../adr/183-migrations-and-database-logins.md): migrations in the api's pre-deploy
  step, as a migration role, and per-service logins.
- [ADR-184](../adr/184-telemetry-collector-and-log-archive.md): the collector, Grafana Cloud and
  the 30-day R2 log archive.
- [ADR-185](../adr/185-release-and-deploy-workflows.md): the release and deploy workflows.

Each ADR's "Plan correction" section carries the PLAN.md and LAUNCH.md edits for the
integrator (PLAN §7, §18, §21, §22, §24; LAUNCH.md C rows 6, 9, 10, 12, 14).

## Security review

The security-auditor review (effort max) of the first version found one high, six medium and
ten low findings. Each was fixed:

| Finding | Fix |
| --- | --- |
| H1: the deploy job installed the Shopify CLI from npm (install scripts on) and restored a cached Railway CLI build while holding `RAILWAY_TOKEN` | Four jobs, at most one secret each; Railway CLI from its release tarball by SHA-256; Shopify CLI from a committed lockfile with `--ignore-scripts`; no shared tool cache |
| M1: IaC cannot create domains or set their port; a database TCP proxy would stay | Domains out of `railway.py`; `ensure_network.py` after every deploy; TCP proxies fail the deploy |
| M2: staging unprotected, manual runs from any ref, a weak branch check | `check_protection.py` for both environments (exactly `main`; reviewer for production); manual runs only from `main` |
| M3: scanners and images under test ran in the job that could sign provenance | `publish` only builds, pushes and signs; `verify` is read-only |
| M4: Shopify's `id_token` in URLs could reach telemetry | `transform/scrub` and `url.query` deletion; the smoke test plants tokens and checks none leave |
| M5: credential scope | Evidence-only R2 token for services, per-environment buckets and tokens, test credentials only in preview and PR environments (founder setup below) |
| M6: the engine has ctl's database privileges | Cannot be fixed in this stream (migrations are not mine); open item 1 below |
| L1: an old success of the same image satisfied the wait | Only deployments created after the apply count |
| L2: a phase without an image removed the service's source | Every phase passes every image; `railway_plan.py check` refuses source removal; pinned plans; `SERVICE_VERSION` baked at build time |
| L3: `deployed` set before the apply finished; promotion on a skipped smoke test | `deployed` only at the end; production needs `verified` |
| L4: passwords typed visibly; `pg_stat_statements` | `read -rsp`; statement tracking off for the session |
| L5: weak tests | Stronger bootstrap, image and collector tests |
| L6: no signer digest; shellcheck unpinned; floating PostgreSQL tag unexplained | `--signer-digest`; hash-pinned shellcheck; ADR-183 records the exception |
| L7: unauthenticated OTLP receiver | `bearertokenauth` with `RAMPSMITH_OTLP_TOKEN` |
| L8: Partner API token on api | ctl only |
| L9: guard accepted any LTS line; images not checked | 26.x only; web and engine images checked |
| L10: no evidence file | This file |

### Second review (effort max, on `af2100e`)

One high, one medium and nine low findings, each fixed:

| Finding | Fix |
| --- | --- |
| N-1 high: `jdx/mise-action` restored the shared Actions cache (Node.js, npm) in the Shopify token job and the LTS-guard job; any job on `main` can write that cache under a predictable key | `cache: false` on every mise-action step in both workflows; `WorkflowHygiene` tests enforce it |
| N-2 medium: the signing build read and wrote the BuildKit Actions cache that other `main` jobs can write | `publish` builds without a cache; a test enforces it |
| N-3: BuildKit daemon image `moby/buildkit:buildx-stable-1` (floating) | pinned by digest (`BUILDKIT_IMAGE` in `release.yml`) |
| N-4: a branch rule without `type` was read as a branch | refused unless `type` is `branch` |
| N-5: destructive changes recognised only by Railway's severity label | refused by kind too: only create, update and set pass |
| N-6: the manifest merged artifacts by wildcard | exactly the four `verified-<service>` artifacts, or the release stops |
| N-7: scrubbing gaps (string arrays, status messages, structured bodies, client secrets, presigned URLs, PEM keys, URL passwords) | header attributes dropped whole, more patterns, status messages and string-converted bodies scrubbed; ADR-184 says exactly what is covered |
| N-8: "cannot check for repository secrets" was wrong | `scope` job fails while a deploy secret exists as a repository or organization secret |
| N-9: a corrected domain port passed silently | corrected and still fails the run |
| N-10: the engine holds a read-write token for all evidence | cannot be scoped in R2; recorded in ADR-182 and open item 4 |
| N-11: bootstrap session hygiene | `log_transaction_sample_rate = 0`, `track_activities = off`, unset the shell variables |

The review also noted that a rollback across a migration would fail at `sqlx migrate run`
(now `--ignore-missing`, ADR-183) and that no Renovate rule reads `COLLECTOR_IMAGE` (the
comment no longer claims one; integration note 11).

### Third review (effort max, on `9c9f3cd`)

Verdict PASS (no critical, high or medium finding), with three low findings, each fixed:

| Finding | Fix |
| --- | --- |
| R3-1: CLI 5.70.0 exits 0 on a pinned apply even when Railway reports `failed` or `partially_applied` | `apply --json` into a runner file; `railway_plan.py applied` refuses anything but `applied` or `noop` and any failed change, without printing outputs |
| R3-2: the kind allowlist accepted any `*.create`/`*.update`/`*.set`; destructive `resource.update`s relied on the label | exactly `resource.create`, `resource.update`, `variable.set`; database moves and volume resizes or detaches refused by summary and details too |
| R3-3: JSON-key secrets, environment-style assignments and header text were not masked; `code=503` was over-masked | three more patterns; generic query names only after `?`, `&`, `#`, `;` or at the start; smoke test plants the new shapes |

It also confirmed that the api's `/readyz` already accepts a newer schema
(`crates/api/src/health.rs` refuses only `applied < expected`), so integration note 12 is
met. The final run is under "Final state".

## Integration notes (for the integrator and the main builder)

1. `infra/api.Dockerfile` (main builder): the runtime image needs `sqlx` (sqlx-cli 0.9.0,
   features `postgres` and `rustls`) at `/usr/local/bin/sqlx`, `crates/db/migrations` at
   `/usr/local/share/rampsmith/migrations`, and `/bin/sh`. `image_smoke.sh` reports a gap
   until then, and a release on `main` fails on it.
2. (Done, ADR-264: `ctl`, `engine` and `egress` answer it.) `web`, `ctl`, `engine` and `egress` answer `GET /healthz` on `PORT`; `ctl` listens on
   `BIND_ADDR`; the api serves only `/webhooks/*` on `WEBHOOK_BIND_ADDR` (port 8081): 404 for
   everything else, 401 for an unsigned webhook. `image_smoke.sh` checks each.
3. Each Dockerfile declares `ARG SERVICE_VERSION` and `ENV SERVICE_VERSION=$SERVICE_VERSION`;
   `release.yml` passes the commit as a build argument (ADR-185). Until then BuildKit warns that
   the argument is unused, and telemetry carries no version.
4. Telemetry code exports logs over OTLP too (Rust: `opentelemetry-appender-tracing`; engine:
   an OTLP log exporter), and reads `OTEL_EXPORTER_OTLP_HEADERS` (both SDKs do by default).
5. (Decided, ADR-265: sandbox first, off only when the host refuses it.) The engine's Playwright seccomp profile (ADR-028): Railway has no documented way to pass
   `--security-opt seccomp=...`, so the first staging deploy shows whether Chromium starts
   (live check 9).
6. A narrower database role for the engine (open item 1): a migration in `crates/db/migrations`
   that creates `rampsmith_engine_role` with only the job-queue and scan-result grants, and
   `bootstrap.sql` then grants that instead of `rampsmith_worker`.
7. `docs/adr/README.md`: add rows for ADR-181 to ADR-185.
8. PLAN.md and LAUNCH.md: apply each ADR's "Plan correction".
9. Optional: `infra/railway` can join `pnpm-workspace.yaml` and `knip.json` so the IaC moves to
   TypeScript (`railway config pull`), and the Shopify CLI can move into the root
   `devDependencies`.
10. `docs/FOUNDER_SETUP.md` sections 0, 7, 9 and 10: merge "Founder setup" below.
11. `renovate.json`: a regex manager for `COLLECTOR_IMAGE` in `infra/railway/railway.py`, for
    `BUILDKIT_IMAGE` in `release.yml`, for `railway-cli.sha256` (with `RAILWAY_CLI_VERSION`)
    and for `infra/railway/tools/shopify-cli`; until then they are updated by hand.
12. The api's `/readyz` must keep accepting a database whose newest migration is newer than the
    build's own (a rollback, ADR-183), while refusing an older one; `crates/api/src/health.rs`
    does today.

## Founder setup (to merge into `docs/FOUNDER_SETUP.md`)

Steps checked against Railway's, GitHub's, Grafana's and Cloudflare's documentation on
17–18 Oct 2026; button wording marked "not verified" where the docs do not show it.

### GitHub environments (C row 14)

1. Settings > Environments: `staging` and `production`.
2. In both: Deployment branches and tags > Selected branches and tags > add the rule `main`
   (branch). Nothing else. The deploy refuses an environment with any other rule (not verified:
   the exact button wording).
3. `production`: Required reviewers > yourself. A production release asks you twice: once for
   Railway, once for the Shopify app deploy.
4. Environment secrets (never repository secrets):
   `gh secret set RAILWAY_TOKEN --env staging` (the staging project token), the same for
   `production`; `gh secret set SHOPIFY_APP_AUTOMATION_TOKEN --env staging` (the staging app's
   token, row 15) and `--env production` (row 2).
5. Environment variables (not secret), once the domain exists (row 10):
   `gh variable set RAMPSMITH_APP_HOST --env production --body app.<domain>`, and
   `RAMPSMITH_SITE_HOST`, `RAMPSMITH_WEBHOOK_HOST` the same way; staging gets its own hosts.

### Railway (C row 8)

1. Project `rampsmith` with three environments: `production`, `staging`, and `preview` (an
   empty environment that PR environments copy).
2. One project token each for `staging` and `production` (GitHub, above).
3. Shared variables, in each environment with that environment's values (Project Settings >
   Shared Variables; seal the secrets):
   - From LAUNCH.md C: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_PARTNER_API_TOKEN`,
     `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_APP_GID`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
     `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
     `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_EVIDENCE`,
     `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `SES_REGION`, `SES_ACCESS_KEY_ID`,
     `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`, `RAMPSMITH_MASTER_KEYS`.
   - New (ADR-182, ADR-184): `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_OTLP_INSTANCE_ID`,
     `GRAFANA_CLOUD_OTLP_TOKEN`, `R2_BUCKET_LOGS`, `R2_LOGS_ACCESS_KEY_ID`,
     `R2_LOGS_SECRET_ACCESS_KEY`.
   - Generated, each `openssl rand -hex 32`, different per environment: `EGRESS_TOKEN_SECRET`,
     `RAMPSMITH_OTLP_TOKEN`, `RAMPSMITH_DB_PASSWORD_MIGRATOR`, `RAMPSMITH_DB_PASSWORD_API`,
     `RAMPSMITH_DB_PASSWORD_CTL`, `RAMPSMITH_DB_PASSWORD_ENGINE`.
   - `preview` holds test values only (the staging apps of row 15 at most), never production's.
4. Images: GHCR packages start private. Make `rampsmith-web`, `rampsmith-api`,
   `rampsmith-engine` and `rampsmith-egress` public (GitHub > Packages > package settings >
   Change visibility), so Railway can pull them; or add registry credentials to each service.
5. First deploy: the first release on `main` with the tokens set creates the services and the
   database, and stops at the api's pre-deploy step because the database logins do not exist
   yet. Then, from a checkout of `main` with the Railway CLI linked to that environment:

   ```sh
   for name in MIGRATOR API CTL ENGINE; do
     read -rsp "RAMPSMITH_DB_PASSWORD_$name: " value; echo
     export "RAMPSMITH_DB_PASSWORD_$name=$value"
   done; unset value
   railway connect postgres --ssh      # then, at the psql prompt:
   \i infra/railway/bootstrap.sql
   \q
   unset RAMPSMITH_DB_PASSWORD_MIGRATOR RAMPSMITH_DB_PASSWORD_API \
     RAMPSMITH_DB_PASSWORD_CTL RAMPSMITH_DB_PASSWORD_ENGINE
   ```

   paste each password from the shared variable of the same name, then
   `railway redeploy --service api --yes` and re-run the failed release jobs.
6. Point-in-time recovery: `railway postgres pitr enable --service postgres` in `staging` and
   `production` (or the database's Backups tab).
7. If the PostgreSQL template added a TCP proxy, delete it (`railway tcp-proxy list --service
   postgres`, then `railway tcp-proxy delete <id> --service postgres`): every deploy fails while
   one exists.
8. Domains: the first deploy with the host variables set registers the three custom domains
   and prints each one's DNS records in the run's notices. Add them in Cloudflare (row 10);
   SSL/TLS mode Full (strict).
9. PR environments (optional): Project Settings > Environments > enable PR environments, base
   environment `preview`, focused PR environments on; connect the GitHub repository (not
   verified: the wording).

### Grafana Cloud (C row 9)

The OpenTelemetry tile's values go to the collector only, as shared variables:
`GRAFANA_CLOUD_OTLP_ENDPOINT` (the OTLP endpoint, `https://otlp-gateway-<region>.grafana.net/otlp`),
`GRAFANA_CLOUD_OTLP_INSTANCE_ID` (the Instance ID), `GRAFANA_CLOUD_OTLP_TOKEN` (the generated
token, `metrics:write`, `logs:write`, `traces:write`). Services do not get
`OTEL_EXPORTER_OTLP_*` from the tile; `railway.py` points them at the collector.

### Cloudflare R2 (C row 6)

Replace the single token scoped to two buckets with one token per use:
- per environment, an evidence bucket and a token scoped to it alone (`R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_EVIDENCE`), 90-day lifecycle rule as now;
- per environment, a logs bucket (`R2_BUCKET_LOGS`, e.g. `rampsmith-logs-staging`) with a
  lifecycle rule deleting objects after 30 days, and a token scoped to it alone
  (`R2_LOGS_ACCESS_KEY_ID`, `R2_LOGS_SECRET_ACCESS_KEY`);
- the backups bucket keeps its own token, held by the backup job only (WS-8), never by a
  Railway service.

## LAUNCH.md E: live checks this stream adds

Each has a substitute test that passes in CI now and skips live with a notice naming its C row.

| Live check | Inputs (C) | Substitute test now | Live command |
| --- | --- | --- | --- |
| 1. Staging deploy: two pinned-plan phases, every service on its digest | 8, 14 | `test_railway.py`, `test_scripts.py` (plan phases and checks on recorded plan shapes), images started as Railway starts them | a release on `main`, or `gh workflow run deploy.yml -f environment=staging -f release=<sha> -f web-image=... -f api-image=... -f engine-image=... -f egress-image=...` |
| 2. Environment protection | 14 | `test_scripts.py` `EnvironmentProtection` | the `railway` job's "Environment protection" step |
| 3. Database logins and migrations on Railway | 8, 12 | `bootstrap_test.sh` on PostgreSQL 18 | `railway connect postgres --ssh`, `\i infra/railway/bootstrap.sql`, `railway redeploy --service api --yes`; then `/readyz` 200 in the api's deploy |
| 4. Point-in-time recovery on | 8 | none (Railway feature) | `railway postgres pitr status --service postgres --json` in each environment |
| 5. Public exposure exactly as listed | 8, 10 | `test_scripts.py` `EnsureNetwork` | `RAILWAY_TOKEN=... python3 infra/railway/scripts/ensure_network.py staging` |
| 6. Public smoke tests and TLS | 10 | `image_smoke.sh` (health, webhook listener 404/401) | the `smoke` job |
| 7. Telemetry: a trace, a metric and a log in Grafana; the log in the R2 archive under `<environment>/logs/` | 6, 9 | `infra/collector/tests/smoke.py` | Grafana Explore; `aws s3 ls --endpoint-url https://<account>.r2.cloudflarestorage.com s3://<logs bucket>/staging/logs/ --recursive` |
| 8. Collector start-up: one configuration only (Railway start command and the image's `CMD`) | 8 | `smoke.py` starts it with the same command | `railway logs --service collector` shows one "Everything is ready", "Starting HTTP server" on `[::]:4318` only, and no "Starting GRPC server" (the image's default config would add an unauthenticated gRPC receiver) |
| 9. Engine starts on Railway without the seccomp option (ADR-028) | 8 | `image_smoke.sh engine` (starts as Railway does; asserts the logged sandbox mode, ADR-265) | the `railway` job's wait for `engine`, then `railway logs --service engine` |
| 10. Shopify app deploy | 1, 2, 15 | `npm ci --ignore-scripts` and `shopify version` in `release.yml` | the `shopify` job |
| 11. Production promotion waits for the founder | 14 | `check_protection.py --require-reviewer` tests | a release with staging verified: the `railway production` job waits for review |
| 12. Node.js LTS guard lets a deploy through | none (a pin change) | the guard against real binaries in `release.yml` | the first release after `.mise.toml` and the images move to a 26.x LTS release |

## Failures outside this stream's paths

- None in `ci.yml` on this branch so far (see "Final state" for the last run).

## Open items

1. Engine database role (security review M6): needs a migration (database stream) and a
   one-line `bootstrap.sql` change (this stream, after it).
2. Synthetic install-scan-fix journey: `deploy.yml` warns that it did not run until the
   dev-store suite exists.
3. A repository-level `RAILWAY_TOKEN` or `SHOPIFY_APP_AUTOMATION_TOKEN` would be the fallback
   when an environment lacks its own: the `scope` job now fails every deploy while one exists.
4. The engine's evidence token (second review N-10): R2 tokens cannot be limited to a prefix or
   to writes, so a browser escape in the engine reaches every tenant's evidence. Fix in code:
   ctl mints presigned upload URLs for the engine (or a separate upload bucket), and the
   engine loses `R2_SECRET_ACCESS_KEY`.
5. Public exposure is checked at every deploy, not between deploys; a scheduled verify-only
   run would need the Railway token outside a deploy (founder decision).

## Final state

Filled in at the end of the stream.
