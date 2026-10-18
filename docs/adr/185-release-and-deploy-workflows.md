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
| `actions/cache` | v6.1.0 | same as `ci.yml` |
| `jdx/mise-action` (mise 2026.10.12) | v5.2.0 | same as `ci.yml` |
| actionlint | v1.7.12 (31 Mar 2026), `go install`, checksums from sum.golang.org | newest tag |
| Railway CLI | 5.70.0, `cargo install --locked` | ADR-181 |
| Shopify CLI | `@shopify/cli` 4.9.4 (npm, `engines.node >=22.12.0`) | PLAN §7 |

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
`actions: read`; `gh attestation verify` takes `--signer-workflow`, `--source-ref`,
`--source-digest` and `--deny-self-hosted-runners` ([manual](https://cli.github.com/manual/gh_attestation_verify)).

## Decision

### `release.yml` (push to `main`; dry run on pull requests touching deployment files)

1. `config`: the IaC and helper unit tests, actionlint with shellcheck, and the Node.js LTS guard
   against real binaries (it must refuse the pinned 26.12.0 today and accept 24.22.0, an LTS
   release).
2. `collector`: `otelcol-contrib validate` and the end-to-end smoke test (ADR-184).
3. `images` (pull requests): each `infra/<service>.Dockerfile` is built and started exactly as
   Railway will start it (`image_smoke.sh`: start and pre-deploy commands and ports read from
   `railway.py`, a PostgreSQL 18.6 service container, the bootstrap logins, throwaway
   credentials). A missing Dockerfile or an integration gap is a warning here.
4. `publish` (main): build once, push `ghcr.io/billyribeiro-ux/rampsmith-<service>:<commit>`
   (no `latest`), a plain image manifest (`provenance: false`, `sbom: false` in BuildKit), a
   CycloneDX SBOM, a grype scan that fails on fixable high or critical findings, then two
   Sigstore-signed attestations pushed to the registry: SLSA build provenance and the SBOM. The
   same smoke test runs on the pushed digest, and here a missing Dockerfile or any gap fails.
5. `manifest` gathers the four digests; `staging` and then `production` call `deploy.yml` with
   them. Production runs only if staging really deployed.

### `deploy.yml` (called, or run by hand from `main` to redeploy or roll back)

1. Validates the environment, the 40-character commit and the four digest references, and that
   the commit is on `main`.
2. Production only: reads its own GitHub environment and stops unless a required reviewer and a
   branch policy exist. GitHub's required reviewers hold the job until the founder approves;
   this step catches an environment that was never protected.
3. Verifies every image's provenance: signed by `release.yml` in this repository, from
   `refs/heads/main`, at this commit, on a GitHub-hosted runner.
4. **Node.js LTS guard**: `node_lts_guard.py` runs the binary `.mise.toml` pins and reads
   `process.release.lts`. When the Railway token is present and the guard fails, the deploy
   fails; when the token is absent, the summary records that the guard would refuse.
5. **Skips, never fake passes**: no `RAILWAY_TOKEN` in the environment → notice and summary
   "skipped (LAUNCH.md C row 8)" and the job ends without touching Railway; no
   `SHOPIFY_APP_AUTOMATION_TOKEN` or `shopify.app.<environment>.toml` → "skipped (rows 1, 2,
   15)"; no `RAMPSMITH_APP_HOST` / `RAMPSMITH_WEBHOOK_HOST` → public smoke tests "skipped
   (row 10)"; the synthetic journey, not built yet, is a warning saying it did not run.
6. **Railway, in two phases**: `railway config apply --file infra/railway/railway.py
   --environment <name> --yes`, first with only the api's new image (its pre-deploy step
   migrates; `/readyz` gates traffic), waiting until the api runs that digest; then with all
   images, waiting for `ctl`, `egress`, `engine`, `web` and the collector. `--environment` must
   match the project token's environment, so a token in the wrong GitHub environment fails
   instead of deploying elsewhere. Without `--confirm-destructive`, a plan that removes a
   service, variable or domain stops for a human. `wait_for_deployment.py` reads `railway
   deployment list --json` and matches the image recorded in each deployment's
   `meta.serviceManifest.source.image`; it never prints `meta`'s values.
7. `shopify app deploy --config <environment> --allow-updates --source-control-url <commit URL>`
   (never `--allow-deletes`).
8. Public smoke tests: `GET https://<app>/healthz` is 200; on the webhook host `/readyz` is 404
   and unsigned `POST /webhooks/shopify` and `/webhooks/github` are 401; plain HTTP redirects.
9. Rollback is this workflow run by hand with an earlier release's commit and digests (each
   release run's summary lists them). Migrations are never rolled back (PLAN §22).

### Permissions and secrets

Both workflows default to `permissions: read-all`; each job asks for less. Only `publish` may
write packages and mint OIDC tokens for signing; the deploy job reads contents, packages,
attestations and actions. `RAILWAY_TOKEN` and `SHOPIFY_APP_AUTOMATION_TOKEN` are environment
secrets passed by name, nothing else is passed, and no step echoes a secret (presence checks
print only true or false).

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

## Rejected alternatives

- BuildKit's own provenance attestations: unsigned, and they turn each image into an index.
- `secrets: inherit`: hands every repository secret to the deploy job.
- Deploying from pull requests: previews come from Railway PR environments (ADR-181), and a
  pull request never holds a deploy token.
- Treating a skipped deploy as success for promotion: production would run untested digests.

## Plan correction

PLAN §24, "Release pipeline". Replace steps 1 to 4 with:

> 1. Build once; push each image by commit tag; scan it; attach Sigstore-signed SLSA build
>    provenance and a CycloneDX SBOM attestation to its digest; start each image as Railway will
>    and smoke-test it.
> 2. Deploy those digests to staging (`deploy.yml`): verify their provenance, refuse a Node.js
>    pin that is not LTS, migrate in the api's pre-deploy step before the other services move,
>    deploy the Shopify app configuration, and run the public smoke tests and the synthetic
>    install-scan-fix journey.
> 3. Promote the same digests to production after a manual approval on the protected
>    `production` environment; the job refuses to run if that environment has no required
>    reviewer.
> 4. Deploy Shopify app configuration and the theme app extension with `shopify app deploy` as a
>    versioned Shopify app release, in each environment after its Railway deploy.
> Each step that needs a founder input skips with a notice naming its LAUNCH.md C row (ADR-185).

PLAN §18, "Compromised dependency" control. Replace "signed build provenance" with:

> Sigstore-signed build provenance and SBOM attestations, verified before every deploy
> (ADR-185)
