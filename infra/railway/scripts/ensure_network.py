"""Hold Railway's public exposure to exactly what ADR-182 allows (ADR-185).

Railway CLI 5.70.0's infrastructure as code cannot register a custom domain, ignores a domain's
target port, and leaves a database's TCP proxy alone (src/iac/change_set.rs), so the file
cannot enforce exposure. This does, with the CLI's own domain and TCP-proxy commands:

- every service in railway.py's SERVICES may have only the custom domains listed in `PUBLIC`,
  each targeting its listed port (web: app and site hosts on 3000; api: the webhook host on
  8081, the webhook-only listener);
- no service may have a Railway-generated domain or any TCP proxy, postgres included.

Usage: python3 ensure_network.py <environment> [--create]
With --create, a listed host that is missing is registered (its DNS records are printed for the
founder). A wrong target port is corrected and still fails the run, because until then that
host reached the wrong listener (the api's private API, say), which someone must look into.
Anything else that is wrong fails, and nothing is ever deleted. Host names come from RAMPSMITH_APP_HOST, RAMPSMITH_SITE_HOST and
RAMPSMITH_WEBHOOK_HOST; an unset one means that domain must not exist yet.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

RAILWAY_PY = Path(__file__).resolve().parent.parent / "railway.py"

Runner = Callable[[list[str]], Any]


def load_railway() -> Any:
    spec = importlib.util.spec_from_file_location("railway_sdk_user", RAILWAY_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def railway_json(args: list[str]) -> Any:
    output = subprocess.run(
        ["railway", *args, "--json"], capture_output=True, text=True, check=True, timeout=120
    ).stdout
    return json.loads(output)


def expected_domains(module: Any, environ: dict[str, str]) -> dict[str, dict[str, int]]:
    wanted: dict[str, dict[str, int]] = {}
    for service, variable, port in module.PUBLIC:
        name = module.host(environ, variable)
        if name:
            wanted.setdefault(service, {})[name] = port
    return wanted


def check_service(
    service: str,
    environment: str,
    wanted: dict[str, int],
    create: bool,
    run: Runner,
) -> tuple[list[str], list[str]]:
    """Returns (problems, notes) for one service."""
    problems: list[str] = []
    notes: list[str] = []
    scope = ["--service", service, "--environment", environment]
    proxies = run(["tcp-proxy", "list", *scope]).get("proxies") or []
    for proxy in proxies:
        port = proxy.get("applicationPort") if isinstance(proxy, dict) else None
        problems.append(
            f"{service} has a public TCP proxy (application port {port}); remove it with "
            f"`railway tcp-proxy delete <id> --service {service}`"
        )
    domains = run(["domain", "list", *scope]).get("domains") or []
    seen: dict[str, int | None] = {}
    for domain in domains:
        if not isinstance(domain, dict):
            continue
        name = str(domain.get("domain", "")).removeprefix("https://").rstrip("/").lower()
        kind = domain.get("type")
        port = domain.get("targetPort", domain.get("target_port"))
        if kind != "custom":
            problems.append(f"{service} has a Railway-generated domain {name}; delete it")
            continue
        if name not in wanted:
            problems.append(f"{service} has an unexpected custom domain {name}")
            continue
        seen[name] = port if isinstance(port, int) else None
    for name, port in wanted.items():
        if name not in seen:
            if not create:
                problems.append(f"{service} is missing its custom domain {name}")
                continue
            run(["domain", name, "--port", str(port), *scope])
            status = run(["domain", "status", name, *scope])
            records = (status.get("domain") or {}).get("dnsRecords") or []
            notes.append(f"registered {name} on {service}, port {port}")
            for record in records:
                notes.append(
                    f"DNS for {name}: {record.get('recordType')} {record.get('fqdn')} -> "
                    f"{record.get('requiredValue')}"
                )
        elif seen[name] != port:
            if not create:
                problems.append(f"{name} targets port {seen[name]}, not {port}")
                continue
            run(["domain", "update", name, "--port", str(port), *scope])
            notes.append(f"{name} now targets port {port} (was {seen[name]})")
            problems.append(
                f"{name} on {service} targeted port {seen[name]}, not {port}, before this run "
                "corrected it: find out how, and what that listener served publicly"
            )
    return problems, notes


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3) or (len(argv) == 3 and argv[2] != "--create"):
        print("usage: ensure_network.py <environment> [--create]")
        return 2
    module = load_railway()
    environment = argv[1]
    create = len(argv) == 3
    wanted = expected_domains(module, dict(os.environ))
    problems: list[str] = []
    for service in module.SERVICES:
        try:
            found, notes = check_service(
                service, environment, wanted.get(service, {}), create, railway_json
            )
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            reason = type(error).__name__
            found, notes = [f"{service}: could not read its networking ({reason})"], []
        problems += found
        for note in notes:
            print(f"::notice title=Railway networking::{note}")
    for problem in problems:
        print(f"::error title=Railway networking::{problem}")
    if not problems:
        print("Public exposure matches ADR-182: only the listed custom domains, no TCP proxies")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
