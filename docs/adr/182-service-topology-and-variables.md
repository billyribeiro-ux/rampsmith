# ADR-182: Service topology, network exposure and variables on Railway

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-9 (`infra/railway/railway.py`)
- Refines: PLAN §6, §18 and §22; LAUNCH.md C rows 1, 9 and 12

## Context

PLAN §6 has three deployables plus `ctl`, `egress` and PostgreSQL; §18 makes `egress` "reachable
only by the engine"; §22 gives `/healthz` and `/readyz`, and "one webhook host that serves only
`/webhooks/shopify`, `/webhooks/github` and `/webhooks/stripe`". Railway's documentation, read on
18 Oct 2026:

- [Private networking, how it works](https://docs.railway.com/networking/private-networking/how-it-works.md):
  each service is `<service>.railway.internal`; in environments created on or after
  16 Oct 2025 the name resolves to IPv4 and IPv6 addresses; "Services in different
  environments ... cannot communicate over the private network"; inside one environment "any
  valid IPv6 or IPv4 traffic is allowed". There is no per-service firewall.
- [Healthchecks](https://docs.railway.com/deployments/healthchecks): checked only at deploy
  time, on the `PORT` variable, with host `healthcheck.railway.app`, until any 2xx or the
  timeout (default 300 s); "not used for continuous monitoring".
- [Start command](https://docs.railway.com/deployments/start-command.md): for an image, "the
  start command overrides the image's `ENTRYPOINT` in exec form"; variables need
  `/bin/sh -c`.
- [Regions](https://docs.railway.com/deployments/regions.md): US East Metal is `us-east4-eqdc4a`.
- [Domains](https://docs.railway.com/networking/domains/working-with-domains.md): a custom
  domain has a target port, so a public host reaches one listener of a service, not all of
  them. Railway CLI 5.70.0's IaC cannot create a custom domain and never applies its port
  (ADR-181), while `railway domain <host> --port`, `railway domain update --port`,
  `railway domain list --json` (`type` custom or service, `targetPort`) and
  `railway tcp-proxy list --json` can (`src/commands/domain.rs`, `tcp_proxy.rs`).

The code reads `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (`crates/api/src/config.rs`,
`crates/ctl/src/config.rs`, `apps/web/src/env.ts`), while LAUNCH.md C row 1 names the founder's
inputs `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`. `docs/FOUNDER_SETUP.md` puts founder inputs in
Railway **shared variables** under the LAUNCH.md names.

## Decision

### Services

| Service | Image | `PORT` (health check) | Health check | Public |
| --- | --- | --- | --- | --- |
| `web` | `rampsmith-web` | 3000 | `/healthz` | app host and site host, port 3000 |
| `api` | `rampsmith-api` | 8080 (private API) | `/readyz` | webhook host only, port **8081** |
| `ctl` | `rampsmith-api`, start `/usr/local/bin/ctl` | 8080 | `/healthz` | no |
| `engine` | `rampsmith-engine` | 8080 | `/healthz` | no |
| `egress` | `rampsmith-egress` | 8888 (proxy) | `/healthz` | no |
| `collector` | `opentelemetry-collector-contrib` from GHCR by digest (ADR-184) | 13133 | `/healthz` | no |
| `postgres` | Railway's PostgreSQL 18 template (ADR-183) | | | no TCP proxy |

Every service runs one replica in `us-east4-eqdc4a`, restarts on failure (10 retries), and
drains before it stops (`ctl` 120 s and `engine` 180 s, so the job in flight finishes). Every
listener binds `[::]` (dual stack). `web` and `api` overlap old and new deployments for 30 s.

### Exposure

- The only public exposure is `PUBLIC` in `railway.py`: the app and site hosts on `web` port
  3000, and the webhook host on `api` port **8081**, a listener that must serve nothing but
  `/webhooks/*` (`WEBHOOK_BIND_ADDR`); the api's private API on 8080, which `web` calls, is
  never reachable from the internet (ADR-005). `infra/railway/scripts/ensure_network.py` runs
  after every deploy: it registers a listed host that is missing (printing its DNS records),
  corrects a wrong target port, and fails the deploy on any Railway-generated domain, any TCP
  proxy (PostgreSQL's included) or any unlisted custom domain. It never deletes: removing
  exposure is a founder step it names.
- **Only `engine` reaches `egress`.** Railway's private network has no per-service rules, so
  the control is: `egress` has no public domain; only `engine` is given `EGRESS_PROXY_URL`; and
  `egress` accepts only requests carrying a token signed with `EGRESS_TOKEN_SECRET`
  (`crates/egress/src/token.rs`), a key held by `engine` and `egress` alone. A compromised
  `web`, `api` or `ctl` on the same network can open a TCP connection to `egress` but cannot
  use it. `EGRESS_ALLOWED_CIDRS`, `EGRESS_TUNNEL_PORTS` and `EGRESS_HTTP_PORTS` are never set.
- Environments cannot reach each other, so a PR environment never sees staging or production.

### Variables

Founder inputs are Railway shared variables with the LAUNCH.md C names, and each service gets a
reference (`${{shared.NAME}}`) only to what it uses. The code's names map as follows:
`SHOPIFY_CLIENT_ID` ← `SHOPIFY_API_KEY`, `SHOPIFY_CLIENT_SECRET` ← `SHOPIFY_API_SECRET`.
Telemetry goes to the collector: every service gets
`OTEL_EXPORTER_OTLP_ENDPOINT=http://${{collector.RAILWAY_PRIVATE_DOMAIN}}:4318`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${{shared.RAMPSMITH_OTLP_TOKEN}}` (both the
Rust `opentelemetry-otlp` 0.33.1 and the Node `@opentelemetry/otlp-exporter-base` exporters
percent-decode header values), and no Grafana credential (ADR-184). The release a service runs
is not a variable: `release.yml` builds each image with `SERVICE_VERSION=<commit>` as a build
argument, so a variable change can never label an old image as a new release.

| Secret (shared variable) | Services |
| --- | --- |
| `SHOPIFY_API_SECRET` | api, ctl |
| `SHOPIFY_PARTNER_API_TOKEN` (with `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_APP_GID`) | ctl (plan sweep, ADR-131) |
| `RAMPSMITH_MASTER_KEYS` | api, ctl |
| `GITHUB_APP_WEBHOOK_SECRET` | api |
| `GITHUB_APP_PRIVATE_KEY` | ctl |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` (not secret) | api, ctl |
| `ANTHROPIC_API_KEY` | engine |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET_EVIDENCE` (a token scoped to the evidence bucket only) | api, ctl, engine |
| `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM` | ctl |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | web |
| `EGRESS_TOKEN_SECRET` (new, generated) | engine, egress |
| `RAMPSMITH_DB_PASSWORD_API`, `_CTL`, `_ENGINE` (new, generated) | api, ctl, engine, each its own |
| `RAMPSMITH_DB_PASSWORD_MIGRATOR` (new, generated) | api, pre-deploy only (ADR-183) |
| `GRAFANA_CLOUD_OTLP_*`, `R2_LOGS_*`, `R2_BUCKET_LOGS` (new, ADR-184) | collector |
| `RAMPSMITH_OTLP_TOKEN` (new, generated) | every service, and the collector that checks it |

Not on Railway: `SHOPIFY_APP_AUTOMATION_TOKEN`, `RAILWAY_TOKEN` and `RAILWAY_API_TOKEN` (GitHub
environment secrets), the dev-store inputs of row 3 (GitHub, for end-to-end tests),
`CLOUDFLARE_API_TOKEN` (GitHub), `R2_BUCKET_BACKUPS` (the WS-8 backup job), and Stripe (row 11,
R3: added to `api` when R3 starts).

Per-environment settings that are not secret come from GitHub environment variables at deploy
time: `RAMPSMITH_APP_HOST`, `RAMPSMITH_SITE_HOST` and `RAMPSMITH_WEBHOOK_HOST` (LAUNCH.md C
row 10). From them `railway.py` sets `WEBAUTHN_RP_ID` and `WEBAUTHN_RP_ORIGIN`, and
`ensure_network.py` the custom domains.

Credentials are scoped per environment and per use: each environment has its own Railway
shared variables, its own R2 buckets with their own tokens (the evidence token cannot touch
the logs or backups bucket), and `preview` and PR environments hold test credentials only
(the staging copies of LAUNCH.md C row 15 at most, never production's).

## Consequences

- `test_railway.py` fails if any secret becomes a literal, reaches a service not in the table,
  or if `PUBLIC` changes; `test_scripts.py` runs `ensure_network.py` against recorded CLI
  output shapes.
- Integration work for the owners of those services (`docs/evidence/ws-9-deploy.md`): `web`,
  `ctl`, `engine` and `egress` must answer `GET /healthz` on `PORT`; `api` must serve the webhook
  routes, and only those, on `WEBHOOK_BIND_ADDR`; `ctl` must listen on `BIND_ADDR`. Until then
  `release.yml` reports each gap as a warning on pull requests and fails a release on `main`.
- Founder inputs grow by the generated secrets above and by the logs bucket and token
  (ADR-184).

## Rejected alternatives

- A public domain on the api's main listener with path filtering in code only: one routing bug
  would expose the private API.
- Relying on the private network to keep `egress` private: Railway has no per-service rules
  inside an environment.
- Copying founder secrets into each service's own variables: more places to rotate, and no
  single view of who holds what.
- Custom domains in `railway.py` (the first version of this ADR): the CLI cannot create them
  and ignores their port, so the file would have promised an exposure it does not enforce.
- An unauthenticated OTLP receiver on the private network: any service could write telemetry,
  including forged security events.

## Plan correction

PLAN §22, "Services" table, `api` row, notes cell. Replace it with:

> `/healthz` for liveness; `/readyz` checks the database and the migration version and is
> Railway's deploy health check. Public traffic reaches only a second listener that serves
> `/webhooks/*` (ADR-182).

PLAN §18, "Server-side request forgery" control. Replace "reachable only by the engine" with:

> reachable only by the engine: it has no public address, only the engine is given its address,
> and it serves only requests signed with a key that only the engine holds (ADR-182)

LAUNCH.md C row 12, "Variables" cell. Append:

> `EGRESS_TOKEN_SECRET`, `RAMPSMITH_OTLP_TOKEN`, and the database passwords
> `RAMPSMITH_DB_PASSWORD_MIGRATOR`,
> `RAMPSMITH_DB_PASSWORD_API`, `RAMPSMITH_DB_PASSWORD_CTL`, `RAMPSMITH_DB_PASSWORD_ENGINE`
> (each `openssl rand -hex 32`, per environment, ADR-182 and ADR-183)

LAUNCH.md C row 10, "Variables" cell. Append:

> GitHub environment variables (not secrets) `RAMPSMITH_APP_HOST`, `RAMPSMITH_SITE_HOST`,
> `RAMPSMITH_WEBHOOK_HOST` in `staging` and `production` (ADR-182)
