# ADR-181: Railway services as infrastructure as code, in Python

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-9 (`infra/railway/`)
- Refines: ADR-010, PLAN §22 and §24, LAUNCH.md B ("Deployment as configuration")

## Context

LAUNCH.md B asks for "Railway service definitions ... as configuration", and the stream brief
for "config as code in the format Railway documents today". Railway's documentation, read on
18 Oct 2026:

- [Config as Code](https://docs.railway.com/config-as-code/reference.md): "Config as Code is
  deprecated." `railway.json` and `railway.toml` keep working for legacy services only "until
  2026-12-01", four months before the planned launch (PLAN §26).
- [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code.md) replaces it: one
  authoring file describes services, databases, variables, custom domains, volumes and
  replicas; `railway config plan` shows the changes and `railway config apply` makes them.
  `.railway/railway.ts` is generally available; `.railway/railway.py` and `.railway/railway.go`
  are beta. `--file` selects another path ([CLI reference](https://docs.railway.com/cli/config.md)).
- The GitHub Action that applies it "needs a project token for the target environment, stored
  as the `RAILWAY_TOKEN` secret", so a project token per environment (LAUNCH.md C row 8) is
  enough; no workspace token is needed to deploy.

What the CLI really does was read from its source, `railwayapp` 5.70.0 on crates.io (crate
checksum `419e90a9a0727d0cb218cc4dbed8da01ee7d820b989a0deb2dbeb09800e5a24a`, the same release
as the `v5.70.0` tag of railwayapp/cli, 16 Oct 2026):

- `src/iac/eval.rs`: a `.py` file is run as `python3 -c <script> <file>`, which imports it with
  `importlib`, calls `main(ctx)` and prints the project as JSON. The process environment is
  inherited, and only `RAILWAY_IAC_CONTEXT` is added. Standard output is the result, so the
  file must not print.
- `src/commands/config/runner.rs`: `RAILWAY_TOKEN` authenticates as a project token, and
  `--environment` must name that token's environment or the command fails. `--yes` refuses
  destructive changes unless `--confirm-destructive` is also given.
- `src/iac/engine.rs`: apply calls `environmentApplyChangeSet` and commits the change, which
  Railway deploys.
- `src/iac/compiler.rs`: a shared-variable reference compiles to the string
  `${{shared.NAME}}` and a service reference to `${{service.NAME}}`; `preserve()` leaves the
  existing value alone.
- `src/iac/change_set.rs` (`diff_top_level_field`): a service declared **without** `source`
  is planned as removing the source it has, not as keeping it. The same file reports custom
  domains as an error diagnostic ("cannot be created through IaC") and leaves
  `customDomains`, `serviceDomains` and a database's TCP proxy out of the diff, so a domain's
  target port is never applied.
- `src/iac/saved_plan.rs`: `railway config plan --out <file>` pins the change set together
  with the environment's config etag and a hash of `./.railway`; `railway config apply --plan
  <file>` applies exactly that change set and fails if the environment changed since, or if
  `./.railway` hashes differently.
- `railway config plan --json` prints `ok`, `changeSet.changes` (summary, severity, kind),
  `diagnostics`, `currentGraph` and `desiredGraph`, with variable values redacted.

The repository's gates rule out a TypeScript file outside the pnpm workspace. A probe on this
branch (17 Oct 2026, Node 26.12.0, pnpm 12.14.0) put two files in `infra/railway/`: `eslint .`
failed with "was not found by the project service" for both, and `knip` reported both as
unused files. Fixing that needs `pnpm-workspace.yaml`, `knip.json` and a lockfile change, which
this stream does not own; and even then `railway/iac` must resolve for ESLint's type-aware
rules in the `node` job.

## Decision

1. **`infra/railway/railway.py` is the definition**, written with Railway's Python IaC helpers
   (`railway-sdk` 0.7.0 on PyPI, 14 Oct 2026, installed with `pip install --require-hashes`).
   The package "mirrors `railway/iac` (TypeScript)" and "compiles to the same RailwayGraph
   shape" (its module docstring), so the file can be moved to TypeScript later without a
   change in meaning (`railway config pull` renders TypeScript).
2. **Pinned CLI**: Railway CLI 5.70.0 from its official release tarball
   (`railway-v5.70.0-x86_64-unknown-linux-musl.tar.gz`), checked against the SHA-256 in
   `infra/railway/tools/railway-cli.sha256` by `install_railway_cli.sh`. `release.yml` checks
   that pin against the digest GitHub records for the release asset on every run. No source
   build and no shared cache (a cache written by one job could be read as a binary by the
   deploy job), and never the npm wrapper, whose postinstall downloads a binary unchecked.
3. **Images come in through the environment.** `release.yml` builds each image once and passes
   its digest to `deploy.yml`, which sets `RAMPSMITH_IMAGE_<SERVICE>` for every service on each
   plan. `railway.py` accepts only `ghcr.io/billyribeiro-ux/rampsmith-<service>@sha256:<64 hex>`
   and raises on anything else, so a tag can never reach Railway. Because a missing source
   means "remove the source", `deploy.yml` always passes every image (the one running now for a
   service a phase does not move), and `railway_plan.py check` refuses a plan that would change
   or drop any source it did not ask for (ADR-185).
4. **Every apply is a pinned plan.** `deploy.yml` runs `railway config plan --json --out`,
   checks the JSON with `railway_plan.py`, and applies with `railway config apply --plan`, so
   what was checked is what is applied, and a change made in the dashboard in between makes
   the apply fail instead of being overwritten. The CLI runs from a scratch directory whose
   `.railway/release` names the release and the git trees of `infra/railway` and
   `infra/collector`, which is what the plan's `./.railway` hash binds to.
5. **Environments.** `staging` and `production` run images. `preview` is the base Railway
   copies for each pull request when PR environments are switched on: its services build from
   the repository with `infra/<service>.Dockerfile` and watch patterns, because a PR
   environment copied from an image-based environment would only redeploy the old image.
   `railway.py` refuses any other environment name.
6. **What the file does not do**: create the project or environments, switch on
   point-in-time recovery or PR environments, register custom domains (`ensure_network.py`
   does, ADR-182), or set any secret value. Those are founder steps
   (`docs/evidence/ws-9-deploy.md`, "Founder setup"); every secret is a reference to a Railway
   shared variable that the founder sets (ADR-182).
7. **Tests** (`infra/railway/tests/test_railway.py`) run the exact evaluation script copied
   from the CLI 5.70.0 source and check health checks, the pre-deploy step, public exposure,
   egress isolation, least privilege for every secret, image pinning and the fields the CLI
   accepts (`IAC_RESOURCE_FIELDS`).

## Consequences

- Configuration lives in one reviewed file; a pull request that changes a health check, a
  variable reference or a domain changes `railway.py` and its tests.
- The Python helpers are beta: the pin keeps them stable, and Renovate's minimum release age
  applies to their updates like any other dependency.
- Python 3.15.0 joins the CI toolchains (it is already on every runner image; CI pins it with
  `actions/setup-python`). No Python runs in production.
- Upgrading the CLI means a new pin in `railway-cli.sha256` and `RAILWAY_CLI_VERSION`, and
  re-reading `change_set.rs` and `saved_plan.rs` for the behaviours above.

## Rejected alternatives

- `railway.json` per service: deprecated, unread after 2026-12-01.
- `.railway/railway.ts`: Railway's GA format, but blocked by the ESLint and knip gates until
  `infra/railway` joins the pnpm workspace. See "Plan correction" for the follow-up.
- Driving the GraphQL API directly (`serviceInstanceUpdate`): undocumented for project tokens,
  and a second description of the same settings.
- `railway up` from CI: Railway would rebuild the image, breaking "build once, promote the same
  digest" (PLAN §24).
- `cargo install railwayapp --locked` (the first version of this ADR): sound checksums, but a
  several-minute build that invited a binary cache shared between jobs.
- Plain `railway config apply` after a separate plan: the apply re-evaluates the file and the
  environment, so the checked plan and the applied one could differ.

## Plan correction

PLAN §22, "Deploys", step 2. Replace "Railway's pre-deploy command runs `sqlx migrate run`."
with:

> 2. `deploy.yml` applies `infra/railway/railway.py` (Railway infrastructure as code, ADR-181)
>    with the digests from step 1, as pinned plans checked before they are applied: the api
>    first, whose pre-deploy command runs `sqlx migrate run` as the migration role (ADR-183),
>    then every other service (ADR-185).

PLAN §22, "Environments" table, Preview row. Replace the second cell with:

> One per pull request, through Railway PR environments based on the `preview` environment,
> whose services build from the repository (ADR-181)

PLAN §24, "Release pipeline". Add after step 4:

> Railway configuration is `infra/railway/railway.py`, applied by `deploy.yml` with the Railway
> CLI pinned in ADR-181. Railway's Config as Code (`railway.json`) is deprecated and is not used.

Follow-up for the integrator (optional): once `infra/railway` can join `pnpm-workspace.yaml`
and `knip.json`, `railway config pull` can render the same definition as
`infra/railway/railway.ts` (GA). Until then the Python file is the source of truth.
