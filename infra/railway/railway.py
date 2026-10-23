"""Rampsmith on Railway, as infrastructure as code (ADR-181, ADR-182, ADR-183).

Railway's CLI evaluates this file (`railway config plan|apply --file infra/railway/railway.py`):
it runs `python3`, imports this module and calls `main(ctx)`, and reads the returned project as
JSON from standard output, so nothing here may print to stdout.

Inputs come from the process environment, set by `.github/workflows/deploy.yml`:

- `RAMPSMITH_IMAGE_WEB`, `RAMPSMITH_IMAGE_API`, `RAMPSMITH_IMAGE_CTL`, `RAMPSMITH_IMAGE_ENGINE`,
  `RAMPSMITH_IMAGE_EGRESS`, `RAMPSMITH_IMAGE_BACKUP`: images pinned by digest. `RAMPSMITH_IMAGE_CTL` defaults to the api's
  image when it is unset; set but empty, ctl declares no source. A service without an image
  declares no source, and Railway CLI 5.70.0 plans that as removing the source of a service
  that has one, so deploy.yml always passes every service's image: the new release's or, in
  the first phase, the one running now (ADR-185), and `railway_plan.py check` refuses any plan
  that would drop or change a source it did not ask for.
- `RAMPSMITH_APP_HOST`: the app's public host name (LAUNCH.md C row 10), for passkeys.

Custom domains are not declared here: Railway's IaC cannot create them and ignores their target
port (`src/iac/change_set.rs`, CLI 5.70.0). `ensure_network.py` manages them from `PUBLIC` below
and refuses any other public exposure (ADR-182).

Secrets never appear here. Founder inputs are Railway shared variables named as in LAUNCH.md
section C, referenced only by the services that need them; generated secrets follow ADR-182.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from railway_sdk import github, image, postgres, project, service

PROJECT = "rampsmith"
REPOSITORY = "billyribeiro-ux/rampsmith"
# US East Metal (Virginia), the US region PLAN §22 asks for.
REGION = "us-east4-eqdc4a"

# Environments this file manages. `preview` is the base Railway copies for each pull
# request's environment (ADR-181), so its services build from the repository.
IMAGE_ENVIRONMENTS = ("staging", "production")
PREVIEW = "preview"
ENVIRONMENTS = (*IMAGE_ENVIRONMENTS, PREVIEW)

REGISTRY = "ghcr.io/billyribeiro-ux"
IMAGE_REPOSITORIES = {
    "web": f"{REGISTRY}/rampsmith-web",
    "api": f"{REGISTRY}/rampsmith-api",
    "ctl": f"{REGISTRY}/rampsmith-api",  # same image, different start command
    "engine": f"{REGISTRY}/rampsmith-engine",
    "egress": f"{REGISTRY}/rampsmith-egress",
    "backup": f"{REGISTRY}/rampsmith-backup",
}
IMAGE_INPUTS = {name: f"RAMPSMITH_IMAGE_{name.upper()}" for name in IMAGE_REPOSITORIES}
# The upstream collector, pinned by its index digest (ADR-184). Updated by hand: renovate.json
# has no rule that reads this constant yet (integration note in docs/evidence/ws-9-deploy.md).
# opentelemetry-collector-contrib:0.163.1, digest read from GHCR and Docker Hub (identical) by
# release.yml on 2026-10-18 (run 39088737207). GHCR: no anonymous pull limits.
COLLECTOR_IMAGE = (
    "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib"
    "@sha256:1175b03003053962012f5a231f5567f66a3e8fdb960c7835c0e48f7aa1555806"
)
COLLECTOR_CONFIG = Path(__file__).resolve().parent.parent / "collector" / "config.yaml"

# Ports inside the private network. Every service answers `GET /healthz` on `PORT`, the port
# Railway's deploy-time health check uses; `api` gates traffic on `/readyz` instead.
PORTS = {
    "web": 3000,
    "api": 8080,
    "ctl": 8080,
    "engine": 8080,
    "egress": 8888,
    "collector": 13133,
}
API_WEBHOOK_PORT = 8081  # the only api listener a public domain reaches (ADR-182)
COLLECTOR_OTLP_PORT = 4318
HEALTHCHECKS = {
    "web": "/healthz",
    "api": "/readyz",
    "ctl": "/healthz",
    "engine": "/healthz",
    "egress": "/healthz",
    "collector": "/healthz",
}
# The only public exposure there is: (service, host input, target port). Everything else,
# including Railway-generated domains and TCP proxies, is refused by ensure_network.py.
PUBLIC = (
    ("web", "RAMPSMITH_APP_HOST", PORTS["web"]),
    ("web", "RAMPSMITH_SITE_HOST", PORTS["web"]),
    ("api", "RAMPSMITH_WEBHOOK_HOST", API_WEBHOOK_PORT),
)
SERVICES = ("web", "api", "ctl", "engine", "egress", "collector", "backup", "postgres")

# The nightly logical backup is a cron service inside the project (ADR-251): Railway starts the
# image's entrypoint on this schedule (UTC, at least five minutes apart), and the process exits
# when the backup is done. It has no port, health check or domain, and no preview copy: a pull
# request's environment holds throwaway data and must not hold the backup credentials.
BACKUP_CRON = "17 2 * * *"
BACKUP_DB_LOGIN = "rampsmith_backup"
# A failed run is retried twice (a network blip), then stays failed for the next night.
BACKUP_RESTART_RETRIES = 2

MIGRATIONS = "/usr/local/share/rampsmith/migrations"
# Railway runs a Docker image's start and pre-deploy commands in exec form, so anything that
# needs a variable runs through `/bin/sh -c` (ADR-183). `--ignore-missing` lets a rollback to an
# older image start on a database that already has newer (expand-only) migrations; a changed
# migration still fails its checksum.
PRE_DEPLOY_COMMANDS = {
    "api": (
        '/bin/sh -c "DATABASE_URL=$MIGRATION_DATABASE_URL '
        f'exec /usr/local/bin/sqlx migrate run --ignore-missing --source {MIGRATIONS}"'
    ),
}
START_COMMANDS = {
    # The migration credential is for the pre-deploy step only: the api process never sees it.
    "api": '/bin/sh -c "unset MIGRATION_DATABASE_URL; exec /usr/local/bin/api"',
    "ctl": "/usr/local/bin/ctl",
    "collector": "/otelcol-contrib --config=env:OTELCOL_CONFIG",
}

# How long a replaced deployment keeps running: workers finish the job in flight.
DRAINING_SECONDS = {
    "web": 30,
    "api": 30,
    "ctl": 120,
    "engine": 180,
    "egress": 60,
    "collector": 30,
    "backup": 60,
}

# Database logins, one per service, created by bootstrap.sql (ADR-183). Passwords are
# generated hex strings, so they need no escaping inside a URL.
DB_LOGINS = {
    "api": ("rampsmith_api", "RAMPSMITH_DB_PASSWORD_API"),
    "ctl": ("rampsmith_ctl", "RAMPSMITH_DB_PASSWORD_CTL"),
    "engine": ("rampsmith_engine", "RAMPSMITH_DB_PASSWORD_ENGINE"),
}
DB_MIGRATOR = ("rampsmith_migrator", "RAMPSMITH_DB_PASSWORD_MIGRATOR")

_DIGEST_REF = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9./_-]*)@sha256:[0-9a-f]{64}$")
_HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def shared(name: str) -> str:
    """A reference to a Railway shared variable (what `ctx.shared.NAME` compiles to)."""
    return "${{shared." + name + "}}"


def ref(service_name: str, variable: str) -> str:
    """A reference to another service's variable, such as its private domain."""
    return "${{" + service_name + "." + variable + "}}"


def private_url(service_name: str, port: int) -> str:
    # The private network is encrypted (WireGuard), and Railway asks for http:// on it.
    return f"http://{ref(service_name, 'RAILWAY_PRIVATE_DOMAIN')}:{port}"


def database_url(login: str, password_variable: str) -> str:
    return (
        f"postgresql://{login}:{shared(password_variable)}"
        f"@{ref('postgres', 'RAILWAY_PRIVATE_DOMAIN')}:5432/{ref('postgres', 'PGDATABASE')}"
    )


def preserve_existing() -> dict[str, str]:
    """Keep whatever value Railway already holds (the SDK's `preserve()`)."""
    return {"type": "preserve"}


def host(environ: Mapping[str, str], variable: str) -> str | None:
    """A validated public host name from the environment, or None when unset."""
    value = environ.get(variable, "").strip().lower()
    if not value:
        return None
    if _HOST.fullmatch(value) is None:
        raise ValueError(f"{variable} must be a host name such as app.example.com")
    return value


class Inputs:
    """Deploy-time inputs, validated before anything is planned."""

    def __init__(self, environ: Mapping[str, str]) -> None:
        self.images: dict[str, str] = {}
        for name, variable in IMAGE_INPUTS.items():
            raw = environ.get(variable)
            if raw is None and name == "ctl":
                raw = environ.get(IMAGE_INPUTS["api"])
            value = (raw or "").strip()
            if not value:
                continue
            match = _DIGEST_REF.fullmatch(value)
            if match is None or match["repository"] != IMAGE_REPOSITORIES[name]:
                raise ValueError(
                    f"{variable} must be {IMAGE_REPOSITORIES[name]}@sha256:<64 hex digits>"
                )
            self.images[name] = value
        self.app_host = host(environ, "RAMPSMITH_APP_HOST")


def _environment(ctx: Any) -> str:
    name = getattr(ctx, "environment", None) if ctx is not None else None
    if name not in ENVIRONMENTS:
        raise ValueError(
            f"railway.py manages the environments {', '.join(ENVIRONMENTS)}, not {name!r}"
        )
    return str(name)


def _common(name: str) -> dict[str, Any]:
    # SERVICE_VERSION is baked into each image at build time (release.yml build-arg), so a
    # variable change never redeploys an old image under a new version label.
    variables: dict[str, Any] = {"PORT": str(PORTS[name])}
    if name != "collector":
        # Traces, metrics and logs go to the collector on the private network (ADR-184),
        # with a token only Rampsmith's own services hold.
        variables["OTEL_EXPORTER_OTLP_ENDPOINT"] = private_url("collector", COLLECTOR_OTLP_PORT)
        variables["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
        variables["OTEL_EXPORTER_OTLP_HEADERS"] = (
            "Authorization=Bearer%20" + shared("RAMPSMITH_OTLP_TOKEN")
        )
    return variables


def _deploy(name: str) -> dict[str, Any]:
    return {
        "restartPolicyType": "ON_FAILURE",
        "restartPolicyMaxRetries": 10,
        "drainingSeconds": DRAINING_SECONDS[name],
    }


def _source(name: str, env: str, inputs: Inputs) -> dict[str, Any]:
    """The source and build settings of one service in one environment."""
    if name == "backup":
        # Only staging and production declare it (main), and only from a pinned image.
        reference = inputs.images.get(name)
        return {"source": image(reference)} if reference else {}
    if name == "collector":
        return {"source": image(COLLECTOR_IMAGE)}
    image_name = "api" if name == "ctl" else name
    if env == PREVIEW:
        return {
            "source": github(REPOSITORY, branch="main"),
            "build": {
                "builder": "DOCKERFILE",
                "dockerfilePath": f"infra/{image_name}.Dockerfile",
                "watchPatterns": WATCH_PATTERNS[image_name],
            },
        }
    reference = inputs.images.get(name)
    return {"source": image(reference)} if reference else {}


# What a pull request must touch for Railway's focused PR environments to rebuild a service.
WATCH_PATTERNS = {
    "web": ["apps/web/**", "packages/**", "package.json", "pnpm-lock.yaml", "infra/web.Dockerfile"],
    "api": [
        "crates/**",
        "Cargo.toml",
        "Cargo.lock",
        ".sqlx/**",
        "rust-toolchain.toml",
        "infra/api.Dockerfile",
    ],
    "engine": [
        "packages/**",
        "package.json",
        "pnpm-lock.yaml",
        "infra/engine.Dockerfile",
        "infra/engine.seccomp.json",
    ],
    "egress": [
        "crates/egress/**",
        "crates/telemetry/**",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "infra/egress.Dockerfile",
    ],
}

# Founder inputs (LAUNCH.md C), referenced as shared variables by the services that use them.
# The R2 token Railway services get is scoped to the evidence bucket only (ADR-182).
R2_EVIDENCE = {
    "R2_ACCOUNT_ID": shared("R2_ACCOUNT_ID"),
    "R2_ACCESS_KEY_ID": shared("R2_ACCESS_KEY_ID"),
    "R2_SECRET_ACCESS_KEY": shared("R2_SECRET_ACCESS_KEY"),
    "R2_BUCKET_EVIDENCE": shared("R2_BUCKET_EVIDENCE"),
}
SHOPIFY_APP = {
    # LAUNCH.md C row 1's names, which the api and ctl read since R0 renamed them (ADR-031).
    "SHOPIFY_API_KEY": shared("SHOPIFY_API_KEY"),
    "SHOPIFY_API_SECRET": shared("SHOPIFY_API_SECRET"),
}
SHOPIFY_PARTNER = {
    "SHOPIFY_PARTNER_API_TOKEN": shared("SHOPIFY_PARTNER_API_TOKEN"),
    "SHOPIFY_PARTNER_ORG_ID": shared("SHOPIFY_PARTNER_ORG_ID"),
    "SHOPIFY_APP_GID": shared("SHOPIFY_APP_GID"),
}


def _web(env: str, inputs: Inputs) -> Any:
    variables = {
        **_common("web"),
        "HOST": "::",
        "API_URL": private_url("api", PORTS["api"]),
        "SHOPIFY_API_KEY": shared("SHOPIFY_API_KEY"),
        "TURNSTILE_SITE_KEY": shared("TURNSTILE_SITE_KEY"),
        # The api runs the free scanner: it verifies the challenge, keeps the limits and queues
        # the scan. This service holds the widget's public key and the secret it presents to the
        # api, and no Turnstile secret (ADR-267).
        "FREE_SCANNER_BACKEND": "api",
        "FREE_SCAN_SERVICE_TOKEN": shared("FREE_SCAN_SERVICE_TOKEN"),
    }
    return service(
        "web",
        **_source("web", env, inputs),
        healthcheck=HEALTHCHECKS["web"],
        healthcheckTimeout=120,
        deploy={**_deploy("web"), "overlapSeconds": 30},
        replicas={REGION: 1},
        env=variables,
    )


def _api(env: str, inputs: Inputs) -> Any:
    login, password = DB_LOGINS["api"]
    variables = {
        **_common("api"),
        "RUST_LOG": "info",
        "BIND_ADDR": f"[::]:{PORTS['api']}",
        "WEBHOOK_BIND_ADDR": f"[::]:{API_WEBHOOK_PORT}",
        "DATABASE_URL": database_url(login, password),
        "MIGRATION_DATABASE_URL": database_url(*DB_MIGRATOR),
        **SHOPIFY_APP,
        "RAMPSMITH_MASTER_KEYS": shared("RAMPSMITH_MASTER_KEYS"),
        # The free scanner (ADR-267): the secret the web service presents, and the Turnstile
        # secret the api verifies the challenge with.
        "FREE_SCAN_SERVICE_TOKEN": shared("FREE_SCAN_SERVICE_TOKEN"),
        "TURNSTILE_SECRET_KEY": shared("TURNSTILE_SECRET_KEY"),
        "WEBAUTHN_RP_ID": inputs.app_host or preserve_existing(),
        "WEBAUTHN_RP_ORIGIN": (
            f"https://{inputs.app_host}" if inputs.app_host else preserve_existing()
        ),
        "GITHUB_APP_ID": shared("GITHUB_APP_ID"),
        "GITHUB_APP_CLIENT_ID": shared("GITHUB_APP_CLIENT_ID"),
        "GITHUB_APP_WEBHOOK_SECRET": shared("GITHUB_APP_WEBHOOK_SECRET"),
        **R2_EVIDENCE,
    }
    return service(
        "api",
        **_source("api", env, inputs),
        start=START_COMMANDS["api"],
        preDeploy=PRE_DEPLOY_COMMANDS["api"],
        healthcheck=HEALTHCHECKS["api"],
        healthcheckTimeout=300,
        deploy={**_deploy("api"), "overlapSeconds": 30, "preDeployTimeoutSeconds": 900},
        replicas={REGION: 1},
        env=variables,
    )


def _ctl(env: str, inputs: Inputs) -> Any:
    login, password = DB_LOGINS["ctl"]
    variables = {
        **_common("ctl"),
        "RUST_LOG": "info",
        "BIND_ADDR": f"[::]:{PORTS['ctl']}",
        "DATABASE_URL": database_url(login, password),
        **SHOPIFY_APP,
        # Plan state (ADR-131): ctl's sweep reads the Partner API. Give it to api too only when
        # the api's code reads it.
        **SHOPIFY_PARTNER,
        "RAMPSMITH_MASTER_KEYS": shared("RAMPSMITH_MASTER_KEYS"),
        # Seals a protected store's password for one scan, for the engine alone (ADR-266).
        "RAMPSMITH_SCAN_SECRET_KEYS": shared("RAMPSMITH_SCAN_SECRET_KEYS"),
        "GITHUB_APP_ID": shared("GITHUB_APP_ID"),
        "GITHUB_APP_CLIENT_ID": shared("GITHUB_APP_CLIENT_ID"),
        "GITHUB_APP_PRIVATE_KEY": shared("GITHUB_APP_PRIVATE_KEY"),
        "SES_REGION": shared("SES_REGION"),
        "SES_ACCESS_KEY_ID": shared("SES_ACCESS_KEY_ID"),
        "SES_SECRET_ACCESS_KEY": shared("SES_SECRET_ACCESS_KEY"),
        "EMAIL_FROM": shared("EMAIL_FROM"),
        **R2_EVIDENCE,
    }
    return service(
        "ctl",
        **_source("ctl", env, inputs),
        start=START_COMMANDS["ctl"],
        healthcheck=HEALTHCHECKS["ctl"],
        healthcheckTimeout=120,
        deploy=_deploy("ctl"),
        replicas={REGION: 1},
        env=variables,
    )


def _engine(env: str, inputs: Inputs) -> Any:
    login, password = DB_LOGINS["engine"]
    variables = {
        **_common("engine"),
        "DATABASE_URL": database_url(login, password),
        # The only service given the proxy's address and its token key (ADR-182).
        "EGRESS_PROXY_URL": private_url("egress", PORTS["egress"]),
        "EGRESS_TOKEN_SECRET": shared("EGRESS_TOKEN_SECRET"),
        # Opens the password ctl sealed for the scan it is running; not a master key (ADR-266).
        "RAMPSMITH_SCAN_SECRET_KEYS": shared("RAMPSMITH_SCAN_SECRET_KEYS"),
        "ANTHROPIC_API_KEY": shared("ANTHROPIC_API_KEY"),
        **R2_EVIDENCE,
    }
    return service(
        "engine",
        **_source("engine", env, inputs),
        healthcheck=HEALTHCHECKS["engine"],
        healthcheckTimeout=180,
        deploy=_deploy("engine"),
        replicas={REGION: 1},
        env=variables,
    )


def _egress(env: str, inputs: Inputs) -> Any:
    variables = {
        **_common("egress"),
        "RUST_LOG": "info",
        "EGRESS_BIND": f"[::]:{PORTS['egress']}",
        "EGRESS_TOKEN_SECRET": shared("EGRESS_TOKEN_SECRET"),
    }
    return service(
        "egress",
        **_source("egress", env, inputs),
        healthcheck=HEALTHCHECKS["egress"],
        healthcheckTimeout=60,
        deploy=_deploy("egress"),
        replicas={REGION: 1},
        env=variables,
    )


def _collector(env: str, inputs: Inputs) -> Any:
    variables = {
        **_common("collector"),
        "OTELCOL_CONFIG": COLLECTOR_CONFIG.read_text(encoding="utf-8"),
        "RAMPSMITH_OTLP_TOKEN": shared("RAMPSMITH_OTLP_TOKEN"),
        "GRAFANA_CLOUD_OTLP_ENDPOINT": shared("GRAFANA_CLOUD_OTLP_ENDPOINT"),
        "GRAFANA_CLOUD_OTLP_INSTANCE_ID": shared("GRAFANA_CLOUD_OTLP_INSTANCE_ID"),
        "GRAFANA_CLOUD_OTLP_TOKEN": shared("GRAFANA_CLOUD_OTLP_TOKEN"),
        # Each environment's log archive is its own bucket with its own token, scoped to that
        # bucket only (ADR-184).
        "R2_ENDPOINT": "https://" + shared("R2_ACCOUNT_ID") + ".r2.cloudflarestorage.com",
        "R2_BUCKET_LOGS": shared("R2_BUCKET_LOGS"),
        "AWS_ACCESS_KEY_ID": shared("R2_LOGS_ACCESS_KEY_ID"),
        "AWS_SECRET_ACCESS_KEY": shared("R2_LOGS_SECRET_ACCESS_KEY"),
        "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
        "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
    }
    return service(
        "collector",
        **_source("collector", env, inputs),
        start=START_COMMANDS["collector"],
        healthcheck=HEALTHCHECKS["collector"],
        healthcheckTimeout=60,
        deploy=_deploy("collector"),
        replicas={REGION: 1},
        env=variables,
    )


def _backup(env: str, inputs: Inputs) -> Any:
    """The nightly backup (ADR-251): cron, private network, its own R2 token (ADR-252).

    It holds exactly what it uses and nothing else: no Railway token, no SSH key, no master key,
    no engine R2 token, no telemetry token. `BACKUP_R2_*`, `BACKUP_DB_PASSWORD` and `BACKUP_SIGNING_KEY` are read by no
    other service and by no repository workflow. Unset inputs make the entrypoint warn and exit 0
    (infra/backup/entrypoint.sh), so an unconfigured service never looks like a crashing one.
    """
    variables = {
        "BACKUP_ENVIRONMENT": env,
        "BACKUP_DB_HOST": ref("postgres", "RAILWAY_PRIVATE_DOMAIN"),
        "BACKUP_DB_PORT": "5432",
        "BACKUP_DB_NAME": ref("postgres", "PGDATABASE"),
        "BACKUP_DB_USER": BACKUP_DB_LOGIN,
        "BACKUP_DB_PASSWORD": shared("BACKUP_DB_PASSWORD"),
        # Public keys only; the private halves stay offline (ADR-173).
        "BACKUP_AGE_RECIPIENTS": shared("BACKUP_AGE_RECIPIENTS"),
        # Signs each backup's metadata; the public half is committed (ADR-256). Sealed, like the
        # other secrets of this service, in every environment (ADR-253).
        "BACKUP_SIGNING_KEY": shared("BACKUP_SIGNING_KEY"),
        "R2_ACCOUNT_ID": shared("R2_ACCOUNT_ID"),
        # One bucket per environment, `rampsmith-backups-<environment>` (ADR-252): the shared
        # variable is per environment, and backup.sh refuses a bucket of another name.
        "R2_BUCKET_BACKUPS": shared("R2_BUCKET_BACKUPS"),
        "BACKUP_R2_ACCESS_KEY_ID": shared("BACKUP_R2_ACCESS_KEY_ID"),
        "BACKUP_R2_SECRET_ACCESS_KEY": shared("BACKUP_R2_SECRET_ACCESS_KEY"),
    }
    return service(
        "backup",
        **_source("backup", env, inputs),
        deploy={
            **_deploy("backup"),
            "restartPolicyMaxRetries": BACKUP_RESTART_RETRIES,
            "cronSchedule": BACKUP_CRON,
        },
        replicas={REGION: 1},
        env=variables,
    )


def main(ctx: Any = None) -> Any:
    env = _environment(ctx)
    inputs = Inputs(os.environ)
    resources = [
        # Railway's PostgreSQL 18 template. Point-in-time recovery is switched on once per
        # environment (`railway postgres pitr enable --service postgres`, ADR-183).
        postgres("postgres", region=REGION),
        _collector(env, inputs),
        _egress(env, inputs),
        _engine(env, inputs),
        _ctl(env, inputs),
        _api(env, inputs),
        _web(env, inputs),
    ]
    if env != PREVIEW:
        resources.append(_backup(env, inputs))
    return project(PROJECT, resources=resources)
