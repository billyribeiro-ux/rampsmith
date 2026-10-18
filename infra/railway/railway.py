"""Rampsmith on Railway, as infrastructure as code (ADR-181, ADR-182, ADR-183).

Railway's CLI evaluates this file (`railway config plan|apply --file infra/railway/railway.py`):
it runs `python3`, imports this module and calls `main(ctx)`, and reads the returned project as
JSON from standard output, so nothing here may print to stdout.

Inputs come from the process environment, set by `.github/workflows/deploy.yml`:

- `RAMPSMITH_IMAGE_WEB`, `RAMPSMITH_IMAGE_API` (also runs `ctl`), `RAMPSMITH_IMAGE_ENGINE`,
  `RAMPSMITH_IMAGE_EGRESS`: images built once by `release.yml`, pinned by digest. A missing
  one leaves that service's source unchanged, which is how a deploy updates `api` first.
- `RAMPSMITH_DEPLOY_ONLY`: a comma-separated list of services whose source may change in this
  apply. The first phase of a deploy sets it to `api`, so migrations run in the api's
  pre-deploy step before `ctl`, `engine` or `web` start new code (ADR-185).
- `RAMPSMITH_RELEASE`: the commit being deployed, reported as `SERVICE_VERSION`.
- `RAMPSMITH_APP_HOST`, `RAMPSMITH_SITE_HOST`, `RAMPSMITH_WEBHOOK_HOST`: public host names
  (LAUNCH.md C, row 10). Without them no custom domain is declared.

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
    "engine": f"{REGISTRY}/rampsmith-engine",
    "egress": f"{REGISTRY}/rampsmith-egress",
}
IMAGE_INPUTS = {name: f"RAMPSMITH_IMAGE_{name.upper()}" for name in IMAGE_REPOSITORIES}
# The upstream collector, pinned by its index digest (ADR-184); Renovate refreshes it.
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

MIGRATIONS = "/usr/local/share/rampsmith/migrations"
# Railway runs a Docker image's start and pre-deploy commands in exec form, so anything that
# needs a variable runs through `/bin/sh -c` (ADR-183).
PRE_DEPLOY_COMMANDS = {
    "api": (
        '/bin/sh -c "DATABASE_URL=$MIGRATION_DATABASE_URL '
        f'exec /usr/local/bin/sqlx migrate run --source {MIGRATIONS}"'
    ),
}
START_COMMANDS = {
    # The migration credential is for the pre-deploy step only: the api process never sees it.
    "api": '/bin/sh -c "unset MIGRATION_DATABASE_URL; exec /usr/local/bin/api"',
    "ctl": "/usr/local/bin/ctl",
    "collector": "/otelcol-contrib --config=env:OTELCOL_CONFIG",
}

# How long a replaced deployment keeps running: workers finish the job in flight.
DRAINING_SECONDS = {"web": 30, "api": 30, "ctl": 120, "engine": 180, "egress": 60, "collector": 30}

# Database logins, one per service, created by bootstrap.sql (ADR-183). Passwords are
# generated hex strings, so they need no escaping inside a URL.
DB_LOGINS = {
    "api": ("rampsmith_api", "RAMPSMITH_DB_PASSWORD_API"),
    "ctl": ("rampsmith_ctl", "RAMPSMITH_DB_PASSWORD_CTL"),
    "engine": ("rampsmith_engine", "RAMPSMITH_DB_PASSWORD_ENGINE"),
}
DB_MIGRATOR = ("rampsmith_migrator", "RAMPSMITH_DB_PASSWORD_MIGRATOR")

_DIGEST_REF = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9./_-]*)@sha256:[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
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


class Inputs:
    """Deploy-time inputs, validated before anything is planned."""

    def __init__(self, environ: Mapping[str, str]) -> None:
        self.images: dict[str, str] = {}
        for name, variable in IMAGE_INPUTS.items():
            value = environ.get(variable, "").strip()
            if not value:
                continue
            match = _DIGEST_REF.fullmatch(value)
            if match is None or match["repository"] != IMAGE_REPOSITORIES[name]:
                raise ValueError(
                    f"{variable} must be {IMAGE_REPOSITORIES[name]}@sha256:<64 hex digits>"
                )
            self.images[name] = value
        only = environ.get("RAMPSMITH_DEPLOY_ONLY", "").strip()
        self.only: set[str] | None = None
        if only:
            self.only = {name.strip() for name in only.split(",") if name.strip()}
            unknown = self.only - set(PORTS)
            if unknown:
                raise ValueError(f"RAMPSMITH_DEPLOY_ONLY names unknown services: {sorted(unknown)}")
        release = environ.get("RAMPSMITH_RELEASE", "").strip()
        if release and _COMMIT.fullmatch(release) is None:
            raise ValueError("RAMPSMITH_RELEASE must be a full 40-character commit SHA")
        self.release = release or None
        self.hosts: dict[str, str] = {}
        for key in ("app", "site", "webhook"):
            variable = f"RAMPSMITH_{key.upper()}_HOST"
            value = environ.get(variable, "").strip().lower()
            if not value:
                continue
            if _HOST.fullmatch(value) is None:
                raise ValueError(f"{variable} must be a host name such as app.example.com")
            self.hosts[key] = value


def _environment(ctx: Any) -> str:
    name = getattr(ctx, "environment", None) if ctx is not None else None
    if name not in ENVIRONMENTS:
        raise ValueError(
            f"railway.py manages the environments {', '.join(ENVIRONMENTS)}, not {name!r}"
        )
    return str(name)


def _common(name: str, inputs: Inputs) -> dict[str, Any]:
    variables: dict[str, Any] = {
        "PORT": str(PORTS[name]),
        "SERVICE_VERSION": inputs.release or preserve_existing(),
    }
    if name != "collector":
        # Traces, metrics and logs go to the collector on the private network (ADR-184).
        variables["OTEL_EXPORTER_OTLP_ENDPOINT"] = private_url("collector", COLLECTOR_OTLP_PORT)
        variables["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
    return variables


def _deploy(name: str) -> dict[str, Any]:
    return {
        "restartPolicyType": "ON_FAILURE",
        "restartPolicyMaxRetries": 10,
        "drainingSeconds": DRAINING_SECONDS[name],
    }


def _source(name: str, env: str, inputs: Inputs) -> dict[str, Any]:
    """The source and build settings of one service in one environment."""
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
    if inputs.only is not None and name not in inputs.only:
        return {}
    reference = inputs.images.get(image_name)
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
    "engine": ["packages/**", "package.json", "pnpm-lock.yaml", "infra/engine.Dockerfile"],
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
R2_EVIDENCE = {
    "R2_ACCOUNT_ID": shared("R2_ACCOUNT_ID"),
    "R2_ACCESS_KEY_ID": shared("R2_ACCESS_KEY_ID"),
    "R2_SECRET_ACCESS_KEY": shared("R2_SECRET_ACCESS_KEY"),
    "R2_BUCKET_EVIDENCE": shared("R2_BUCKET_EVIDENCE"),
}
SHOPIFY_APP = {
    # LAUNCH.md C row 1 names the app's credentials SHOPIFY_API_KEY and SHOPIFY_API_SECRET;
    # the code reads Shopify's current names (ADR-182).
    "SHOPIFY_CLIENT_ID": shared("SHOPIFY_API_KEY"),
    "SHOPIFY_CLIENT_SECRET": shared("SHOPIFY_API_SECRET"),
}
SHOPIFY_PARTNER = {
    "SHOPIFY_PARTNER_API_TOKEN": shared("SHOPIFY_PARTNER_API_TOKEN"),
    "SHOPIFY_PARTNER_ORG_ID": shared("SHOPIFY_PARTNER_ORG_ID"),
    "SHOPIFY_APP_GID": shared("SHOPIFY_APP_GID"),
}


def _web(env: str, inputs: Inputs) -> Any:
    variables = {
        **_common("web", inputs),
        "HOST": "::",
        "API_URL": private_url("api", PORTS["api"]),
        "SHOPIFY_CLIENT_ID": shared("SHOPIFY_API_KEY"),
        "TURNSTILE_SITE_KEY": shared("TURNSTILE_SITE_KEY"),
        "TURNSTILE_SECRET_KEY": shared("TURNSTILE_SECRET_KEY"),
    }
    domains = [
        {"domain": inputs.hosts[key], "port": PORTS["web"]}
        for key in ("app", "site")
        if key in inputs.hosts
    ]
    return service(
        "web",
        **_source("web", env, inputs),
        healthcheck=HEALTHCHECKS["web"],
        healthcheckTimeout=120,
        deploy={**_deploy("web"), "overlapSeconds": 30},
        replicas={REGION: 1},
        domains=domains,
        env=variables,
    )


def _api(env: str, inputs: Inputs) -> Any:
    login, password = DB_LOGINS["api"]
    app_host = inputs.hosts.get("app")
    variables = {
        **_common("api", inputs),
        "RUST_LOG": "info",
        "BIND_ADDR": f"[::]:{PORTS['api']}",
        "WEBHOOK_BIND_ADDR": f"[::]:{API_WEBHOOK_PORT}",
        "DATABASE_URL": database_url(login, password),
        "MIGRATION_DATABASE_URL": database_url(*DB_MIGRATOR),
        **SHOPIFY_APP,
        **SHOPIFY_PARTNER,
        "RAMPSMITH_MASTER_KEYS": shared("RAMPSMITH_MASTER_KEYS"),
        "WEBAUTHN_RP_ID": app_host or preserve_existing(),
        "WEBAUTHN_RP_ORIGIN": f"https://{app_host}" if app_host else preserve_existing(),
        "GITHUB_APP_ID": shared("GITHUB_APP_ID"),
        "GITHUB_APP_CLIENT_ID": shared("GITHUB_APP_CLIENT_ID"),
        "GITHUB_APP_WEBHOOK_SECRET": shared("GITHUB_APP_WEBHOOK_SECRET"),
        **R2_EVIDENCE,
    }
    domains = (
        [{"domain": inputs.hosts["webhook"], "port": API_WEBHOOK_PORT}]
        if "webhook" in inputs.hosts
        else []
    )
    return service(
        "api",
        **_source("api", env, inputs),
        start=START_COMMANDS["api"],
        preDeploy=PRE_DEPLOY_COMMANDS["api"],
        healthcheck=HEALTHCHECKS["api"],
        healthcheckTimeout=300,
        deploy={**_deploy("api"), "overlapSeconds": 30, "preDeployTimeoutSeconds": 900},
        replicas={REGION: 1},
        domains=domains,
        env=variables,
    )


def _ctl(env: str, inputs: Inputs) -> Any:
    login, password = DB_LOGINS["ctl"]
    variables = {
        **_common("ctl", inputs),
        "RUST_LOG": "info",
        "BIND_ADDR": f"[::]:{PORTS['ctl']}",
        "DATABASE_URL": database_url(login, password),
        **SHOPIFY_APP,
        **SHOPIFY_PARTNER,
        "RAMPSMITH_MASTER_KEYS": shared("RAMPSMITH_MASTER_KEYS"),
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
        **_common("engine", inputs),
        "DATABASE_URL": database_url(login, password),
        # The only service given the proxy's address and its token key (ADR-182).
        "EGRESS_PROXY_URL": private_url("egress", PORTS["egress"]),
        "EGRESS_TOKEN_SECRET": shared("EGRESS_TOKEN_SECRET"),
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
        **_common("egress", inputs),
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
        **_common("collector", inputs),
        "OTELCOL_CONFIG": COLLECTOR_CONFIG.read_text(encoding="utf-8"),
        "GRAFANA_CLOUD_OTLP_ENDPOINT": shared("GRAFANA_CLOUD_OTLP_ENDPOINT"),
        "GRAFANA_CLOUD_OTLP_INSTANCE_ID": shared("GRAFANA_CLOUD_OTLP_INSTANCE_ID"),
        "GRAFANA_CLOUD_OTLP_TOKEN": shared("GRAFANA_CLOUD_OTLP_TOKEN"),
        # The log archive bucket has its own token, scoped to that bucket only (ADR-184).
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
    return project(PROJECT, resources=resources)
