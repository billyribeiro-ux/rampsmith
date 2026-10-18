# ADR-185: Release and deploy workflows

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-9 (`.github/workflows/release.yml`, `.github/workflows/deploy.yml`)
- Refines: PLAN §18, §22 and §24; CLAUDE.md (Node 26 LTS rule); ADR-016

## Context

PLAN §24's release pipeline: build once and attach signed build provenance to each image
digest; deploy those digests to staging and run smoke tests and the synthetic journey; promote
the same digests to production after a manual approval on the protected `production`
environment; deploy the Shopify app configuration and theme app extension with
`shopify app deploy`. CLAUDE.md: nothing deploys before the Node.js pins move to the first 26.x
release tagged LTS. LAUNCH.md B: deploy steps skip with an explicit notice when their secrets are
absent, and never pretend to pass.

Checked on 17–18 Oct 2026 (versions from `git ls-remote` of each action's repository, the
registries and release tags; SHAs are the tags' commits):

| Tool | Pin | Source |
| --- | --- | --- |
| `actions/checkout` | v7.0.1 `3d3c42e5…` | same as `ci.yml` |
| `actions/attest` | v4.2.2 `1e69f48a…` (4 Aug 2026) | GitHub's [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) now use `actions/attest@v4`; with no predicate it writes SLSA build provenance, with `sbom-path` an SBOM attestation; `create-storage-record` only works for organization-owned repositories |
| `docker/login-action` | v4.6.0 `dbcb8138…` | |
| `docker/setup-buildx-action`, `docker/build-push-action` | v4.4.1, v7.4.0 | same as `ci.yml` |
| `anchore/sbom-action` (syft v1.54.1), `anchore/scan-action` (grype v0.120.1) | v0.24.3, v7.4.2 | same as `ci.yml` |
| `actions/upload-artifact`, `actions/download-artifact` | v7.0.2, v8.0.2 `9000827c…` | |
| `actions/setup-python` (Python 3.15.0), `actions/setup-go` (Go 1.27.2) | v7.0.0 `5fda3b95…`, v7.0.0 `b7ad1dad…` | `actions/python-versions`, `actions/go-versions` tags |
| `jdx/mise-action` (mise 2026.10.12) | v5.2.0 | same as `ci.yml` |
| actionlint | v1.7.12 (31 Mar 2026), `go install`, checksums from sum.golang.org | newest tag |
| shellcheck | `shellcheck-py` 0.11.0.1 (shellcheck 0.11.0), `pip --require-hashes` | `infra/railway/requirements-ci.txt` |
| Railway CLI | 5.70.0 release tarball, SHA-256 `f5182306…04eb` | ADR-181; checked against GitHub's asset digest on every run |
| Shopify CLI | `@shopify/cli` 4.9.4 (npm, `engines.node >=22.12.0`) from `infra/railway/tools/shopify-cli/package-lock.json`, `npm ci --ignore-scripts` | PLAN §7 |

Shopify ([deploy in CI/CD](https://shopify.dev/docs/apps/launch/deployment/deploy-in-ci-cd-pipeline),
[App Automation Tokens](https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens)):
the CLI reads `SHOPIFY_APP_AUTOMATION_TOKEN` and the documented CI command is
`shopify app deploy --config production --allow-updates --source-control-url "$COMMIT_URL"`;
`--allow-deletes` only for manual runs; each token belongs to one app and expires after 1, 3 or
6 months.

GitHub: a called workflow cannot request more permissions than its caller grants (a
`startup_failure` on this branch's first run proved it); environment secrets are read by the
called job that sets `environment:`, and the caller "must still pass the secret", by name
([reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows));
`GET /repos/{owner}/{repo}/environments/{name}` returns `protection_rules`
(`required_reviewers` with `reviewers`) and `deployment_branch_policy`, readable with
`actions: read`, and `GET .../environments/{name}/deployment-branch-policies` lists the selected
branches (`name`, `type`); `gh attestation verify` takes `--signer-workflow`, `--source-ref`,
`--source-digest`, `--signer-digest` and `--deny-self-hosted-runners`
([manual](https://cli.github.com/manual/gh_attestation_verify)). A step's secrets are in that
step's environment only, but every step of a job runs as the same user on the same runner, so
any code a job runs can wait for a later step's secrets: the boundary that holds is the job.

A security review of the first version (`docs/evidence/ws-9-deploy.md`, "Security review")
found that the deploy job installed the Shopify CLI from npm with install scripts and restored
a cached Railway CLI build while holding `RAILWAY_TOKEN`; that scanners and the images under
test ran in the job that could sign provenance; that staging and manual runs were not tied to
`main`; and that a phase that omitted a service's image would, in Railway CLI 5.70.0, remove that
service's source (ADR-181). This version answers each.

## Decision

### `release.yml` (push to `main`; dry run on pull requests touching deployment files)

1. `config`: the IaC and helper unit tests, actionlint with a hash-pinned shellcheck, the
   Railway CLI pin against GitHub's record of the release asset (and an install with it), the
   Shopify CLI lockfile (`npm ci --ignore-scripts`, version as pinned), and the Node.js LTS
   guard against real binaries: it must refuse the pinned 26.12.0 today, accept 24.22.0 (an
   LTS release) when asked about the 24 line, and refuse it for the 26 line.
2. `collector`: `otelcol-contrib validate` and the end-to-end smoke test (ADR-184).
3. `images` (pull requests): each `infra/<service>.Dockerfile` is built and started exactly as
   Railway will start it (`image_smoke.sh`: start and pre-deploy commands and ports read from
   `railway.py`, a PostgreSQL 18.6 service container, the bootstrap logins, throwaway
   credentials). A missing Dockerfile or an integration gap is a warning here.
4. `publish` (main): the only job with `packages: write`, `id-token: write` and
   `attestations: write`, and it runs nothing but BuildKit and `actions/attest`: build once with
   `SERVICE_VERSION=<commit>` as a build argument, push
   `ghcr.io/billyribeiro-ux/rampsmith-<service>:<commit>` (no `latest`) as a plain image
   manifest (`provenance: false`, `sbom: false` in BuildKit), push a Sigstore-signed SLSA build
   provenance attestation for the digest, and log out.
5. `verify` (main, read-only): checks that provenance (`release.yml`, `main`, this commit as
   source and signer digest, GitHub-hosted runner), writes a CycloneDX SBOM and keeps it as a
   90-day artifact, fails on fixable high or critical grype findings, and runs the smoke test on
   the pushed digest, where a missing Dockerfile or any gap fails.
6. `manifest` takes only verified digests; `staging` and then `production` call `deploy.yml`
   with them. Production runs only when staging deployed **and** its public smoke tests passed.

### `deploy.yml` (called, or run by hand from `main` to redeploy or roll back)

Four jobs, so no job that runs third-party code holds a deploy secret, and each secret sits in
one job:

1. `check` (no secret): runs only from `main` for a manual run; validates the environment, the
   40-character commit and the four digest references, and that the commit is on `main`;
   verifies every image's provenance as in `verify`; runs the **Node.js LTS guard**
   (`node_lts_guard.py`) on the binary `.mise.toml` pins and on the `node` inside the web and
   engine images (`docker run --network none --entrypoint node`), each of which must be the
   pinned 26.x release with a non-empty `process.release.lts`.
2. `railway` (`environment: <name>`, `RAILWAY_TOKEN` only; on production GitHub holds it until
   the founder approves):
   - **Skips, never fake passes**: no `RAILWAY_TOKEN` → notice and summary "skipped
     (LAUNCH.md C row 8)", noting row 14 and the LTS guard if they would refuse, and nothing
     touches Railway.
   - With the token: refuses unless the environment is protected (`check_protection.py`:
     deployments limited to selected branches, exactly `main`; for production also a required
     reviewer, LAUNCH.md C row 14), and refuses while the LTS guard fails.
   - Installs `railway-sdk` by hash and the Railway CLI by SHA-256 (ADR-181).
   - **Two pinned-plan phases.** A probe plan reads what each service runs now. Phase 1 moves
     the api alone and passes every other service the image it runs (an empty `ctl` image on
     the first deploy, so ctl starts only after the migrations); phase 2 moves every service.
     Each phase is `railway config plan --json --out`, then `railway_plan.py check` (the plan
     succeeded, no error diagnostic, every change's kind is a create, an update or a set and
     none is labelled destructive, every image exactly as expected, no source removed), then
     `railway config apply --plan --yes`. The JSON and the `.plan` file come from one CLI call
     and carry the change set Railway's own preview returned (`src/iac/engine.rs`), with
     Railway's severities, which is why kinds are checked too; so the change set applied is
     the one checked and a dashboard edit in between fails the apply. `--environment` must
     match the project token's environment. No `--confirm-destructive`.
   - `wait_for_deployment.py` waits for each service's deployment created after that phase's
     apply to reach SUCCESS with the expected image (`meta.serviceManifest.source.image`); a
     service the phase left unchanged passes after two minutes only if its newest deployment of
     all runs the image and succeeded. It never prints `meta`'s values.
   - `ensure_network.py <name> --create` then holds public exposure to `PUBLIC` (ADR-182).
   - Only after all of that: `deployed=true`, and the host names for the smoke job.
3. `shopify` (`environment: <name>`, `SHOPIFY_APP_AUTOMATION_TOKEN` only; on production a second
   approval): no token or no `shopify.app.<environment>.toml` → "skipped (rows 1, 2, 15)";
   otherwise the CLI from the committed lockfile without install scripts, then
   `shopify app deploy --config <environment> --allow-updates --source-control-url <commit URL>`
   (never `--allow-deletes`).
4. `smoke` (no secret, no permissions): no app or webhook host → "skipped (row 10)" and the
   release is not verified, so it is not promoted. Otherwise `GET https://<app>/healthz` is 200;
   on the webhook host `/readyz` and `/healthz` are 404 and unsigned `POST /webhooks/shopify` and
   `/webhooks/github` are 401; plain HTTP redirects; then `verified=true`. The synthetic journey,
   not built yet, is a warning saying it did not run.

Rollback is this workflow run by hand from `main` with an earlier release's commit and digests
(each release run's summary lists them). Migrations are never rolled back (PLAN §22).

### Permissions, caches and secrets

Both workflows default to `permissions: read-all`; each job asks for less. Only `publish` may
write packages and mint OIDC tokens. No job reads a cache another job could have written where
it matters: every `jdx/mise-action` step sets `cache: false` (its cache key is predictable and
any job on `main` can write the Actions cache, so a planted `node` or `sqlx` would run next to
a deploy token or decide a gate), `publish` builds without the BuildKit Actions cache (only the
pull-request dry run reads it, and pull requests cannot write it), and the BuildKit daemon
image is pinned by digest. The manifest takes exactly the four `verified-<service>` artifacts
and fails on any other. `test_scripts.py` `WorkflowHygiene` checks these rules on every run.
The `scope` job, which has no environment, fails while either deploy secret also exists as a
repository or organization secret. `RAILWAY_TOKEN` and `SHOPIFY_APP_AUTOMATION_TOKEN` are
passed by name, as GitHub requires; they must exist only as environment secrets of `staging`
and `production` (an environment secret takes precedence over a repository secret of the same
name, but a repository secret would be the fallback), and no step echoes a secret (presence
checks print only true or false).

## Consequences

- Until the founder adds the Railway tokens, every release run on `main` builds, signs and tests
  the images and ends with a staging summary that says the deploy was skipped, and production
  does not run. Until the Node.js pin is an LTS release, a run with tokens fails at the guard.
- Until `infra/web.Dockerfile`, `infra/engine.Dockerfile` and `infra/egress.Dockerfile` exist, a
  release on `main` fails at `publish` by design: an incomplete set of images cannot ship.
- GHCR packages start private. Railway pulls them only if the founder makes the four packages
  public (the repository already is) or adds registry credentials (founder setup).
- The first deploy of each environment is the live check for the parts the substitute tests
  cannot reach (`docs/evidence/ws-9-deploy.md`, section E list).
- A production release asks the founder to approve twice, Railway first and Shopify after it:
  the price of never holding both tokens in one job.
- A phase-1 plan also carries variable changes for services whose image it keeps, so such a
  service restarts on its current image with the new variables before phase 2. Variables are
  therefore added before code that needs them, like expand-then-contract migrations.

## Rejected alternatives

- BuildKit's own provenance attestations: unsigned, and they turn each image into an index.
- `secrets: inherit`: hands every repository secret to the deploy job.
- Deploying from pull requests: previews come from Railway PR environments (ADR-181), and a
  pull request never holds a deploy token.
- Treating a skipped deploy as success for promotion: production would run untested digests.
- One deploy job for everything (the first version): any package it installed could read both
  tokens.
- An SBOM attestation besides the SBOM artifact: PLAN §24 asks for an SBOM and signed
  provenance; a second signature from the signing job adds nothing the artifact lacks.
- Separate GitHub environments for the Shopify job (one approval each): more founder setup for
  the same protection.

## Plan correction

PLAN §24, "Release pipeline". Replace steps 1 to 4 with:

> 1. Build once; push each image by commit tag and attach Sigstore-signed SLSA build provenance
>    to its digest, in a job that runs nothing else; then, without write access, verify that
>    provenance, record a CycloneDX SBOM, scan the image and start it as Railway will.
> 2. Deploy those digests to staging (`deploy.yml`): verify their provenance, refuse a Node.js
>    pin that is not LTS, migrate in the api's pre-deploy step before the other services move,
>    deploy the Shopify app configuration, and run the public smoke tests and the synthetic
>    install-scan-fix journey.
> 3. Promote the same digests to production after the founder's approval on the protected
>    `production` environment, only once staging's smoke tests passed; the deploy refuses to run
>    if that environment has no required reviewer or accepts branches other than `main`.
> 4. Deploy Shopify app configuration and the theme app extension with `shopify app deploy` as a
>    versioned Shopify app release, in each environment after its Railway deploy, in a job
>    that holds only the Shopify token.
> Each step that needs a founder input skips with a notice naming its LAUNCH.md C row (ADR-185).

PLAN §18, "Compromised dependency" control. Replace "signed build provenance" with:

> Sigstore-signed build provenance, verified before every deploy, and deploy tools installed by
> hash or lockfile in jobs that hold one secret each (ADR-185)

LAUNCH.md C row 14, "Variables" cell. Replace "none" with:

> none; each environment allows deployments from `main` only (selected branches), and
> `production` names the founder as required reviewer (ADR-185)
