"""Refuse the live restore drill unless its GitHub environment is protected as LAUNCH.md C row 16 says.

The drill's credentials (a read-only R2 token and the offline age key) are secrets of the GitHub
environment `backup-drill` and of nothing else. GitHub hands them only to a job that names that
environment, and enforces the environment's branch rule before the job starts, but only the rule
the founder configured. So a job without the environment and without any secret reads the
environment's settings first (`protection` in restore-drill.yml), and the job that does use the
environment `needs` it: when this check fails, that job never starts and the secrets reach no job.

It passes only when:
- the environment is called `backup-drill`; and
- deployments are limited to selected branches and the only selected branch is `main`.

No reviewer is required: the drill runs on a schedule, and a reviewer gate would hold every run
until someone clicked (ADR-253). The rule is the one `infra/railway/scripts/check_protection.py`
applies to staging and production, imported from there so that there is one definition of "limited
to main".

Usage: check_environment.py <environment.json> <branch-policies.json>
where the files hold `gh api repos/OWNER/REPO/environments/backup-drill` and
`gh api repos/OWNER/REPO/environments/backup-drill/deployment-branch-policies`.

Second mode, `check_environment.py --stray <environments.json>` with the output of
`gh api repos/OWNER/REPO/environments`: fails when an environment exists that an earlier design
created and nothing uses any more. The first design ran the backup as a GitHub workflow in the
environments `backup-production` and `backup-staging`; GitHub creates an environment, with no
protection and no reviewer, the first time a workflow names one that does not exist
("Running a workflow that references an environment that does not exist will create an environment
with the referenced name", github/docs, manage-environments), so those two may exist unprotected.
Nothing in this repository names them now, and an unprotected environment is a place a pull
request's workflow could name to collect whatever secret someone later puts there (finding LOW-2,
ADR-259).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

ENVIRONMENT = "backup-drill"
STRAY_ENVIRONMENTS = ("backup-production", "backup-staging")
ROW = "LAUNCH.md section C row 16"
PROTECTION = Path(__file__).resolve().parent.parent / "railway" / "scripts" / "check_protection.py"


def load_protection() -> Any:
    spec = importlib.util.spec_from_file_location("check_protection", PROTECTION)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PROTECTION}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def problems(environment: dict[str, Any], policies: dict[str, Any]) -> list[str]:
    found: list[str] = []
    if environment.get("name") != ENVIRONMENT:
        found.append(f"the environment is not called {ENVIRONMENT}")
    found.extend(load_protection().problems(environment, policies, False))
    return found


def stray(listing: dict[str, Any]) -> list[str]:
    """The names of the environments in a `GET /repos/{owner}/{repo}/environments` listing that must not exist."""
    names = [
        item.get("name")
        for item in listing.get("environments", [])
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    ]
    return [name for name in STRAY_ENVIRONMENTS if name in names]


def main_stray(path: str) -> int:
    try:
        listing = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("::error title=Stray environments::could not read the repository's environments")
        return 1
    if not isinstance(listing, dict):
        print("::error title=Stray environments::unexpected environments listing")
        return 1
    found = stray(listing)
    if found:
        print(
            f"::error title=Stray environments::The environment(s) {', '.join(found)} exist. "
            "The earlier backup workflow created them without protection and nothing uses them now. "
            "Delete them: Settings > Environments > the environment > Delete environment, or "
            "gh api -X DELETE repos/OWNER/REPO/environments/NAME (LAUNCH.md section C row 16)."
        )
        return 1
    print("No stray backup environments.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--stray":
        return main_stray(argv[2])
    if len(argv) != 3:
        print("usage: check_environment.py <environment.json> <policies.json>")
        return 2
    try:
        environment = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        policies = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print(
            f"::error title=Backup drill environment::could not read the {ENVIRONMENT} "
            f"environment's settings ({ROW})"
        )
        return 1
    if not isinstance(environment, dict) or not isinstance(policies, dict):
        print(f"::error title=Backup drill environment::unexpected {ENVIRONMENT} settings")
        return 1
    found = problems(environment, policies)
    if found:
        print(
            f"::error title=Backup drill environment::Refusing to run the live restore drill: "
            f"the {ENVIRONMENT} environment is not protected ({'; '.join(found)}). "
            f"Configure it as {ROW} describes."
        )
        return 1
    print(f"The {ENVIRONMENT} environment has deployments limited to main")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
