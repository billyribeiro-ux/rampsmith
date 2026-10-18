"""Invariants of infra/railway/railway.py (ADR-181, ADR-182, ADR-183).

These run the file the way the Railway CLI does (import it from its path, call `main(ctx)`,
serialise the project) and check what a reviewer would otherwise check by eye: health checks,
the pre-deploy migration, which services are public, that only `engine` can reach `egress`, and
that every secret is a reference to a Railway variable, used only by the services that need it.

Run: python3 -m unittest discover -s infra/railway/tests -v   (railway-sdk installed)
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import shlex
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from railway_sdk import create_railway_context

HERE = Path(__file__).resolve().parent
RAILWAY_PY = HERE.parent / "railway.py"
COLLECTOR_CONFIG = HERE.parent.parent / "collector" / "config.yaml"

DIGEST = "sha256:" + "ab" * 32
IMAGES = {
    "RAMPSMITH_IMAGE_WEB": f"ghcr.io/billyribeiro-ux/rampsmith-web@{DIGEST}",
    "RAMPSMITH_IMAGE_API": f"ghcr.io/billyribeiro-ux/rampsmith-api@{DIGEST}",
    "RAMPSMITH_IMAGE_ENGINE": f"ghcr.io/billyribeiro-ux/rampsmith-engine@{DIGEST}",
    "RAMPSMITH_IMAGE_EGRESS": f"ghcr.io/billyribeiro-ux/rampsmith-egress@{DIGEST}",
}
HOSTS = {
    "RAMPSMITH_APP_HOST": "app.rampsmith.example",
    "RAMPSMITH_SITE_HOST": "rampsmith.example",
    "RAMPSMITH_WEBHOOK_HOST": "hooks.rampsmith.example",
}
RELEASE = {"RAMPSMITH_RELEASE": "0123456789abcdef0123456789abcdef01234567"}
INPUT_NAMES = (*IMAGES, *HOSTS, *RELEASE, "RAMPSMITH_DEPLOY_ONLY")

# Runtime founder inputs in LAUNCH.md section C (rows 1, 2, 4, 5, 6, 7, 9, 12), as Railway
# shared variables, plus the names this stream proposes (ADR-182, ADR-184).
LAUNCH_C_RUNTIME = {
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_PARTNER_API_TOKEN",
    "SHOPIFY_PARTNER_ORG_ID",
    "SHOPIFY_APP_GID",
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_EVIDENCE",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
    "SES_REGION",
    "SES_ACCESS_KEY_ID",
    "SES_SECRET_ACCESS_KEY",
    "EMAIL_FROM",
    "RAMPSMITH_MASTER_KEYS",
}
PROPOSED = {
    "GRAFANA_CLOUD_OTLP_ENDPOINT",
    "GRAFANA_CLOUD_OTLP_INSTANCE_ID",
    "GRAFANA_CLOUD_OTLP_TOKEN",
    "R2_BUCKET_LOGS",
    "R2_LOGS_ACCESS_KEY_ID",
    "R2_LOGS_SECRET_ACCESS_KEY",
    "EGRESS_TOKEN_SECRET",
    "RAMPSMITH_DB_PASSWORD_MIGRATOR",
    "RAMPSMITH_DB_PASSWORD_API",
    "RAMPSMITH_DB_PASSWORD_CTL",
    "RAMPSMITH_DB_PASSWORD_ENGINE",
}

# Which services may hold each secret (least privilege). Anything not listed here may not be
# referenced by any service.
SECRET_USERS = {
    "SHOPIFY_API_SECRET": {"api", "ctl"},
    "SHOPIFY_PARTNER_API_TOKEN": {"api", "ctl"},
    "GITHUB_APP_PRIVATE_KEY": {"ctl"},
    "GITHUB_APP_WEBHOOK_SECRET": {"api"},
    "ANTHROPIC_API_KEY": {"engine"},
    "R2_SECRET_ACCESS_KEY": {"api", "ctl", "engine"},
    "TURNSTILE_SECRET_KEY": {"web"},
    "SES_SECRET_ACCESS_KEY": {"ctl"},
    "RAMPSMITH_MASTER_KEYS": {"api", "ctl"},
    "GRAFANA_CLOUD_OTLP_TOKEN": {"collector"},
    "R2_LOGS_SECRET_ACCESS_KEY": {"collector"},
    "EGRESS_TOKEN_SECRET": {"engine", "egress"},
    "RAMPSMITH_DB_PASSWORD_MIGRATOR": {"api"},
    "RAMPSMITH_DB_PASSWORD_API": {"api"},
    "RAMPSMITH_DB_PASSWORD_CTL": {"ctl"},
    "RAMPSMITH_DB_PASSWORD_ENGINE": {"engine"},
}
SECRET_NAME = re.compile(r"SECRET|TOKEN|PASSWORD|PRIVATE_KEY|MASTER_KEYS|API_KEY|DATABASE_URL")
SHARED_REF = re.compile(r"\$\{\{shared\.([A-Z0-9_]+)\}\}")

# Top-level resource fields Railway CLI 5.70.0 reads (`IAC_RESOURCE_FIELDS` in
# src/iac/compiler.rs of the railwayapp 5.70.0 crate); anything else is an error diagnostic.
CLI_RESOURCE_FIELDS = {
    "address", "type", "name", "kind", "start", "source", "build", "deploy", "networking",
    "variables", "volumeAttachments", "volumeMounts", "config", "configFile",
    "parentServiceId", "groupId", "clusterRole", "replicaConfig", "clusterDisplay", "tracing",
    "cdn", "engine", "image", "env", "output", "defaultMountPath", "color", "icon",
    "isCollapsed", "environments",
}  # fmt: skip

SERVICES = {"web", "api", "ctl", "engine", "egress", "collector"}


def load_module() -> Any:
    spec = importlib.util.spec_from_file_location("railway_sdk_user", RAILWAY_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(environment: str | None, **inputs: str) -> dict[str, dict[str, Any]]:
    """Evaluate railway.py like the CLI and return its resources by name."""
    clean = {key: value for key, value in os.environ.items() if key not in INPUT_NAMES}
    with mock.patch.dict(os.environ, {**clean, **inputs}, clear=True):
        module = load_module()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            project = module.main(create_railway_context({"environment": environment}))
            graph = project.to_graph()
        assert stdout.getvalue() == "", "railway.py must not print: the CLI reads stdout"
    json.dumps(graph)  # the CLI serialises the project as JSON
    assert graph["name"] == "rampsmith"
    return {resource["name"]: resource for resource in graph["resources"]}


def variables(resource: dict[str, Any]) -> dict[str, Any]:
    return dict(resource.get("variables") or {})


def literal(resource: dict[str, Any], name: str) -> str:
    value = variables(resource)[name]
    assert value["type"] == "literal", f"{resource['name']}.{name} is {value['type']}"
    return str(value["value"])


def shared_refs(resource: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for value in variables(resource).values():
        if value.get("type") == "literal":
            found |= set(SHARED_REF.findall(str(value.get("value", ""))))
        if value.get("type") == "sharedReference":
            found.add(value["name"])
    return found


def full() -> dict[str, dict[str, Any]]:
    return evaluate("production", **IMAGES, **HOSTS, **RELEASE)


class Shape(unittest.TestCase):
    def test_the_cli_evaluator_reads_the_file(self) -> None:
        """Run the exact script Railway CLI 5.70.0 uses to evaluate a .py authoring file."""
        script = (HERE / "cli_eval_python.py").read_text(encoding="utf-8")
        context = {"command": "plan", "environment": "staging", "environmentName": "staging"}
        clean = {key: value for key, value in os.environ.items() if key not in INPUT_NAMES}
        result = subprocess.run(
            [sys.executable, "-c", script, str(RAILWAY_PY)],
            capture_output=True,
            text=True,
            check=True,
            env={**clean, **IMAGES, "RAILWAY_IAC_CONTEXT": json.dumps(context)},
        )
        payload = json.loads(result.stdout)
        self.assertIsNone(payload["partial"], "one file owns the whole environment")
        resources = {r["name"]: r for r in payload["project"]["resources"]}
        self.assertEqual(set(resources), SERVICES | {"postgres"})
        self.assertEqual(resources["api"]["source"]["image"], IMAGES["RAMPSMITH_IMAGE_API"])

    def test_every_environment_defines_the_same_services(self) -> None:
        for environment in ("staging", "production", "preview"):
            with self.subTest(environment=environment):
                self.assertEqual(set(evaluate(environment)), SERVICES | {"postgres"})

    def test_unknown_environments_are_refused(self) -> None:
        for environment in (None, "", "dev", "pr-12", "Production"):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                evaluate(environment)

    def test_only_fields_the_cli_reads(self) -> None:
        for name, resource in full().items():
            with self.subTest(resource=name):
                self.assertLessEqual(set(resource), CLI_RESOURCE_FIELDS)

    def test_everything_runs_in_one_us_region(self) -> None:
        for name, resource in full().items():
            with self.subTest(resource=name):
                regions = resource["deploy"]["multiRegionConfig"]
                self.assertEqual(regions, {"us-east4-eqdc4a": {"numReplicas": 1}})


class HealthAndCommands(unittest.TestCase):
    def test_health_checks(self) -> None:
        resources = full()
        for name in SERVICES:
            deploy = resources[name]["deploy"]
            with self.subTest(service=name):
                expected = "/readyz" if name == "api" else "/healthz"
                self.assertEqual(deploy["healthcheckPath"], expected)
                self.assertGreater(deploy["healthcheckTimeout"], 0)
                self.assertEqual(deploy["restartPolicyType"], "ON_FAILURE")
                # Railway health-checks the PORT variable, so each service listens on it.
                self.assertEqual(
                    literal(resources[name], "PORT"), str(load_module().PORTS[name])
                )

    def test_listeners_match_the_health_check_port(self) -> None:
        resources = full()
        self.assertEqual(literal(resources["api"], "BIND_ADDR"), "[::]:8080")
        self.assertEqual(literal(resources["ctl"], "BIND_ADDR"), "[::]:8080")
        self.assertEqual(literal(resources["egress"], "EGRESS_BIND"), "[::]:8888")
        self.assertEqual(literal(resources["web"], "HOST"), "::")

    def test_api_migrates_before_it_deploys(self) -> None:
        resources = full()
        commands = resources["api"]["deploy"]["preDeployCommand"]
        self.assertEqual(len(commands), 1)
        argv = shlex.split(commands[0])
        self.assertEqual(argv[:2], ["/bin/sh", "-c"])
        self.assertEqual(
            argv[2],
            "DATABASE_URL=$MIGRATION_DATABASE_URL exec /usr/local/bin/sqlx migrate run "
            "--source /usr/local/share/rampsmith/migrations",
        )
        for name in SERVICES - {"api"}:
            with self.subTest(service=name):
                self.assertNotIn("preDeployCommand", resources[name]["deploy"])

    def test_the_api_process_never_sees_the_migration_credential(self) -> None:
        resources = full()
        argv = shlex.split(resources["api"]["deploy"]["startCommand"])
        self.assertEqual(
            argv, ["/bin/sh", "-c", "unset MIGRATION_DATABASE_URL; exec /usr/local/bin/api"]
        )
        holders = {n for n, r in resources.items() if "MIGRATION_DATABASE_URL" in variables(r)}
        self.assertEqual(holders, {"api"})

    def test_ctl_runs_from_the_api_image(self) -> None:
        resources = full()
        self.assertEqual(resources["ctl"]["deploy"]["startCommand"], "/usr/local/bin/ctl")
        self.assertEqual(resources["ctl"]["source"], resources["api"]["source"])

    def test_the_collector_reads_its_config_from_a_variable(self) -> None:
        collector = full()["collector"]
        self.assertEqual(
            collector["deploy"]["startCommand"], "/otelcol-contrib --config=env:OTELCOL_CONFIG"
        )
        config = COLLECTOR_CONFIG.read_text(encoding="utf-8")
        self.assertEqual(literal(collector, "OTELCOL_CONFIG"), config)
        # Railway would expand ${{...}} inside the value; the collector's own ${env:...} is safe.
        self.assertNotIn("${{", config)


class Exposure(unittest.TestCase):
    def test_only_web_and_the_webhook_listener_are_public(self) -> None:
        resources = full()
        public = {n for n, r in resources.items() if (r.get("networking") or {}).get("customDomains")}
        self.assertEqual(public, {"web", "api"})
        web = resources["web"]["networking"]["customDomains"]
        self.assertEqual(
            web, {"app.rampsmith.example": {"port": 3000}, "rampsmith.example": {"port": 3000}}
        )
        api = resources["api"]["networking"]["customDomains"]
        self.assertEqual(api, {"hooks.rampsmith.example": {"port": 8081}})
        # The webhook listener is not the private API port Railway health-checks.
        self.assertEqual(literal(resources["api"], "WEBHOOK_BIND_ADDR"), "[::]:8081")
        self.assertNotEqual(literal(resources["api"], "PORT"), "8081")

    def test_nothing_else_is_reachable_from_the_internet(self) -> None:
        for environment in ("staging", "production", "preview"):
            resources = evaluate(environment, **HOSTS)
            for name, resource in resources.items():
                networking = resource.get("networking") or {}
                with self.subTest(environment=environment, resource=name):
                    self.assertFalse(networking.get("tcpProxies"))
                    self.assertFalse(networking.get("serviceDomains"))

    def test_no_domains_without_hosts(self) -> None:
        for name, resource in evaluate("staging").items():
            with self.subTest(resource=name):
                self.assertNotIn("networking", resource)
        api = evaluate("staging")["api"]
        self.assertEqual(variables(api)["WEBAUTHN_RP_ID"], {"type": "preserve"})

    def test_passkeys_bind_to_the_app_host(self) -> None:
        api = full()["api"]
        self.assertEqual(literal(api, "WEBAUTHN_RP_ID"), "app.rampsmith.example")
        self.assertEqual(literal(api, "WEBAUTHN_RP_ORIGIN"), "https://app.rampsmith.example")


class EgressIsolation(unittest.TestCase):
    def test_only_engine_knows_the_proxy(self) -> None:
        resources = full()
        holders = {n for n, r in resources.items() if "EGRESS_PROXY_URL" in variables(r)}
        self.assertEqual(holders, {"engine"})
        self.assertEqual(
            literal(resources["engine"], "EGRESS_PROXY_URL"),
            "http://${{egress.RAILWAY_PRIVATE_DOMAIN}}:8888",
        )

    def test_only_engine_and_egress_hold_the_token_key(self) -> None:
        holders = {n for n, r in full().items() if "EGRESS_TOKEN_SECRET" in shared_refs(r)}
        self.assertEqual(holders, {"engine", "egress"})

    def test_no_environment_opens_private_ranges(self) -> None:
        for environment in ("staging", "production", "preview"):
            egress = evaluate(environment)["egress"]
            for name in ("EGRESS_ALLOWED_CIDRS", "EGRESS_TUNNEL_PORTS", "EGRESS_HTTP_PORTS"):
                with self.subTest(environment=environment, variable=name):
                    self.assertNotIn(name, variables(egress))


class Secrets(unittest.TestCase):
    def test_secrets_are_references_never_values(self) -> None:
        for environment in ("staging", "production", "preview"):
            resources = evaluate(environment, **IMAGES, **HOSTS, **RELEASE)
            for name, resource in resources.items():
                for key, value in variables(resource).items():
                    if not SECRET_NAME.search(key) or key in {"OTELCOL_CONFIG"}:
                        continue
                    with self.subTest(environment=environment, service=name, variable=key):
                        if value["type"] == "preserve":
                            continue
                        self.assertEqual(value["type"], "literal")
                        self.assertRegex(value["value"], SHARED_REF)
                        # Nothing but references and fixed text around them.
                        rest = SHARED_REF.sub("", value["value"])
                        rest = re.sub(r"\$\{\{[a-z]+\.[A-Z_]+\}\}", "", rest)
                        self.assertNotRegex(rest, r"[0-9a-f]{16}")

    def test_shared_variables_are_known_inputs(self) -> None:
        used: set[str] = set()
        for resource in full().values():
            used |= shared_refs(resource)
        self.assertLessEqual(used, LAUNCH_C_RUNTIME | PROPOSED)
        self.assertEqual(LAUNCH_C_RUNTIME - used, set(), "every runtime input reaches a service")

    def test_each_secret_reaches_only_its_services(self) -> None:
        resources = full()
        for secret, allowed in SECRET_USERS.items():
            holders = {n for n, r in resources.items() if secret in shared_refs(r)}
            with self.subTest(secret=secret):
                self.assertEqual(holders, allowed)

    def test_each_service_connects_as_its_own_login(self) -> None:
        resources = full()
        for service, login in (("api", "rampsmith_api"), ("ctl", "rampsmith_ctl"),
                               ("engine", "rampsmith_engine")):
            with self.subTest(service=service):
                url = literal(resources[service], "DATABASE_URL")
                self.assertTrue(url.startswith(f"postgresql://{login}:"))
                self.assertIn(f"RAMPSMITH_DB_PASSWORD_{service.upper()}", url)
        for name in ("web", "egress", "collector"):
            with self.subTest(service=name):
                self.assertNotIn("DATABASE_URL", variables(resources[name]))

    def test_telemetry_goes_to_the_collector(self) -> None:
        resources = full()
        for name in SERVICES - {"collector"}:
            with self.subTest(service=name):
                self.assertEqual(
                    literal(resources[name], "OTEL_EXPORTER_OTLP_ENDPOINT"),
                    "http://${{collector.RAILWAY_PRIVATE_DOMAIN}}:4318",
                )
                self.assertNotIn("OTEL_EXPORTER_OTLP_HEADERS", variables(resources[name]))


class Images(unittest.TestCase):
    def test_images_are_pinned_by_digest(self) -> None:
        resources = evaluate("staging", **IMAGES)
        for name, variable in (("web", "WEB"), ("api", "API"), ("ctl", "API"),
                               ("engine", "ENGINE"), ("egress", "EGRESS")):
            with self.subTest(service=name):
                self.assertEqual(
                    resources[name]["source"],
                    {"type": "image", "image": IMAGES[f"RAMPSMITH_IMAGE_{variable}"]},
                )

    def test_a_missing_image_leaves_the_source_unchanged(self) -> None:
        resources = evaluate("staging", RAMPSMITH_IMAGE_API=IMAGES["RAMPSMITH_IMAGE_API"])
        self.assertIn("source", resources["api"])
        self.assertIn("source", resources["ctl"])
        for name in ("web", "engine", "egress"):
            with self.subTest(service=name):
                self.assertNotIn("source", resources[name])

    def test_the_first_phase_moves_only_the_api(self) -> None:
        resources = evaluate("production", **IMAGES, RAMPSMITH_DEPLOY_ONLY="api")
        self.assertEqual(resources["api"]["source"]["image"], IMAGES["RAMPSMITH_IMAGE_API"])
        for name in ("ctl", "web", "engine", "egress"):
            with self.subTest(service=name):
                self.assertNotIn("source", resources[name])
        # The collector's pinned image is part of the file, not of a release.
        self.assertIn("source", resources["collector"])
        with self.assertRaises(ValueError):
            evaluate("production", **IMAGES, RAMPSMITH_DEPLOY_ONLY="api,worker")

    def test_floating_or_foreign_images_are_refused(self) -> None:
        bad = (
            "ghcr.io/billyribeiro-ux/rampsmith-api:latest",
            "ghcr.io/billyribeiro-ux/rampsmith-api:0123456789abcdef0123456789abcdef01234567",
            f"ghcr.io/someone-else/rampsmith-api@{DIGEST}",
            f"ghcr.io/billyribeiro-ux/rampsmith-web@{DIGEST}",
            "ghcr.io/billyribeiro-ux/rampsmith-api@sha256:" + "AB" * 32,
            "ghcr.io/billyribeiro-ux/rampsmith-api@sha256:" + "ab" * 31,
        )
        for value in bad:
            with self.subTest(image=value), self.assertRaises(ValueError):
                evaluate("staging", RAMPSMITH_IMAGE_API=value)

    def test_release_and_hosts_are_validated(self) -> None:
        for key, value in (("RAMPSMITH_RELEASE", "main"),
                           ("RAMPSMITH_RELEASE", "0123456"),
                           ("RAMPSMITH_APP_HOST", "https://app.example.com"),
                           ("RAMPSMITH_WEBHOOK_HOST", "hooks.example.com/webhooks")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                evaluate("staging", **{key: value})

    def test_the_release_is_the_service_version(self) -> None:
        for name, resource in full().items():
            if name == "postgres":
                continue
            with self.subTest(service=name):
                self.assertEqual(literal(resource, "SERVICE_VERSION"), RELEASE["RAMPSMITH_RELEASE"])

    def test_the_collector_image_is_pinned(self) -> None:
        module = load_module()
        self.assertRegex(
            module.COLLECTOR_IMAGE, r"^otel/opentelemetry-collector-contrib@sha256:[0-9a-f]{64}$"
        )
        self.assertNotRegex(module.COLLECTOR_IMAGE, r"@sha256:0{64}$", "pin the real digest")

    def test_preview_builds_from_the_repository(self) -> None:
        resources = evaluate("preview", **IMAGES)
        for name in ("web", "api", "ctl", "engine", "egress"):
            image = "api" if name == "ctl" else name
            with self.subTest(service=name):
                self.assertEqual(
                    resources[name]["source"],
                    {"type": "github", "repo": "billyribeiro-ux/rampsmith", "branch": "main"},
                )
                build = resources[name]["build"]
                self.assertEqual(build["builder"], "DOCKERFILE")
                self.assertEqual(build["dockerfilePath"], f"infra/{image}.Dockerfile")
                self.assertIn(f"infra/{image}.Dockerfile", build["watchPatterns"])

    def test_postgres_is_railways_postgresql_18_template(self) -> None:
        postgres = full()["postgres"]
        self.assertEqual(postgres["engine"], "postgres")
        self.assertEqual(postgres["image"], "ghcr.io/railwayapp-templates/postgres-ssl:18")


if __name__ == "__main__":
    unittest.main()
