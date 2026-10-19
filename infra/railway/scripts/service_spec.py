"""Print one service's runtime settings from railway.py as JSON, for the image smoke tests.

The smoke tests start each release image with the start command, pre-deploy command, port and
health check that Railway will use, read from railway.py so the two cannot drift (ADR-185).

Usage: python3 service_spec.py <web|api|ctl|engine|egress|collector>
Output: {"port": 8080, "healthcheck": "/readyz", "start": [...argv], "preDeploy": [...argv]}
with each command split the way a shell would split it (Railway runs them in exec form).
"""

from __future__ import annotations

import importlib.util
import json
import shlex
import sys
from pathlib import Path

RAILWAY_PY = Path(__file__).resolve().parent.parent / "railway.py"


def main(argv: list[str]) -> int:
    spec = importlib.util.spec_from_file_location("railway_sdk_user", RAILWAY_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if len(argv) != 2 or argv[1] not in module.PORTS:
        print(f"usage: service_spec.py <{'|'.join(module.PORTS)}>", file=sys.stderr)
        return 2
    name = argv[1]
    start = module.START_COMMANDS.get(name)
    pre_deploy = module.PRE_DEPLOY_COMMANDS.get(name)
    print(
        json.dumps(
            {
                "port": module.PORTS[name],
                "healthcheck": module.HEALTHCHECKS[name],
                "start": shlex.split(start) if start else None,
                "preDeploy": shlex.split(pre_deploy) if pre_deploy else None,
                "webhookPort": module.API_WEBHOOK_PORT if name == "api" else None,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
