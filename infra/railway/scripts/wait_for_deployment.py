"""Wait until a Railway service is running an exact image (ADR-185).

`railway config apply` commits the change and Railway deploys it asynchronously. This polls
`railway deployment list --service <name> --json` (fields: id, status, createdAt, meta) until
the newest deployment of the expected image reports SUCCESS, which for a service with a health
check means the check passed and traffic moved to it.

It fails on FAILED, CRASHED, REMOVED or SKIPPED, and when no deployment of the image appears in
time. It prints ids, statuses and timestamps only: a deployment's `meta` is never printed,
only the names of its keys when the image cannot be found in it.

Usage: python3 wait_for_deployment.py <service> <image@sha256:...> [timeout seconds]
Authentication is the Railway CLI's (RAILWAY_TOKEN, a project token for one environment).
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any

DONE = "SUCCESS"
FAILED = {"FAILED", "CRASHED", "REMOVED", "REMOVING", "SKIPPED"}
POLL_SECONDS = 10


def deployed_image(deployment: dict[str, Any]) -> str | None:
    """The image a deployment runs, from the service manifest Railway records in `meta`."""
    meta = deployment.get("meta")
    if not isinstance(meta, dict):
        return None
    for path in (("serviceManifest", "source", "image"), ("image",)):
        value: Any = meta
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        if isinstance(value, str) and value:
            return value
    return None


def list_deployments(service: str) -> list[dict[str, Any]]:
    output = subprocess.run(
        ["railway", "deployment", "list", "--service", service, "--json", "--limit", "20"],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stdout
    parsed = json.loads(output)
    if not isinstance(parsed, list):
        raise ValueError("railway deployment list did not return a list")
    return [item for item in parsed if isinstance(item, dict)]


def wait(
    service: str,
    image: str,
    timeout: float,
    lister: Callable[[str], list[dict[str, Any]]] = list_deployments,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[bool, str]:
    deadline = clock() + timeout
    last = "no deployments yet"
    while True:
        deployments = lister(service)
        matching = [d for d in deployments if deployed_image(d) == image]
        if matching:
            newest = max(matching, key=lambda d: str(d.get("createdAt", "")))
            status = str(newest.get("status", ""))
            summary = f"{service}: deployment {newest.get('id')} is {status}"
            if status == DONE:
                return True, summary
            if status in FAILED:
                return False, summary
            last = summary
        elif deployments:
            newest = max(deployments, key=lambda d: str(d.get("createdAt", "")))
            meta = newest.get("meta")
            keys = sorted(meta) if isinstance(meta, dict) else []
            last = (
                f"{service}: newest deployment {newest.get('id')} is {newest.get('status')} "
                f"and does not run the expected image (meta keys: {', '.join(keys) or 'none'})"
            )
        if clock() >= deadline:
            return False, f"timed out: {last}"
        sleep(POLL_SECONDS)


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4) or "@sha256:" not in argv[2]:
        print("usage: wait_for_deployment.py <service> <image@sha256:...> [timeout]")
        return 2
    timeout = float(argv[3]) if len(argv) == 4 else 1200.0
    try:
        ok, message = wait(argv[1], argv[2], timeout)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        ok, message = False, f"{argv[1]}: could not read deployments ({type(error).__name__})"
    if ok:
        print(message)
        return 0
    print(f"::error title=Railway deploy of {argv[1]}::{message}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
