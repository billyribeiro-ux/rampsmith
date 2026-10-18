"""Refuse a deploy unless its GitHub environment is protected as LAUNCH.md C row 14 says.

GitHub enforces an environment's rules before a job that uses it starts, but only the rules the
founder configured. So each deploy reads its own environment first, with no secret in reach,
and stops unless:

- deployments are limited to selected branches and the only selected branch is `main`
  (`deployment_branch_policy` with `custom_branch_policies`, and the branch-policy list
  `[main]`), for staging and production alike, so no other branch's workflow can use the
  environment's secrets; and
- for production, a required-reviewers rule names at least one reviewer, so the founder
  approves every production deploy (PLAN §24).

Usage: check_protection.py <environment.json> <branch-policies.json> [--require-reviewer]
where the files hold `gh api repos/OWNER/REPO/environments/NAME` and
`gh api repos/OWNER/REPO/environments/NAME/deployment-branch-policies` (ADR-185).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def problems(environment: dict[str, Any], policies: dict[str, Any], reviewer: bool) -> list[str]:
    found: list[str] = []
    if reviewer:
        reviewers = [
            person
            for rule in environment.get("protection_rules") or []
            if isinstance(rule, dict) and rule.get("type") == "required_reviewers"
            for person in (rule.get("reviewers") or [])
        ]
        if not reviewers:
            found.append("no required reviewer is configured")
    policy = environment.get("deployment_branch_policy")
    if not (isinstance(policy, dict) and policy.get("custom_branch_policies") is True):
        found.append("deployments are not limited to selected branches")
    else:
        branches = [
            (item.get("name"), item.get("type", "branch"))
            for item in policies.get("branch_policies") or []
            if isinstance(item, dict)
        ]
        if branches != [("main", "branch")]:
            names = ", ".join(f"{name} ({kind})" for name, kind in branches) or "none"
            found.append(f"the selected branches must be exactly main, not: {names}")
    return found


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4) or (len(argv) == 4 and argv[3] != "--require-reviewer"):
        print("usage: check_protection.py <environment.json> <policies.json> [--require-reviewer]")
        return 2
    try:
        environment = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        policies = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("::error title=Environment protection::could not read the environment settings")
        return 1
    if not isinstance(environment, dict) or not isinstance(policies, dict):
        print("::error title=Environment protection::unexpected environment settings")
        return 1
    name = environment.get("name", "?")
    found = problems(environment, policies, len(argv) == 4)
    if found:
        print(
            f"::error title=Environment protection::Refusing to deploy: the {name} environment "
            f"is not protected ({'; '.join(found)}). Configure it as LAUNCH.md C row 14 describes."
        )
        return 1
    rules = "a required reviewer and " if len(argv) == 4 else ""
    print(f"The {name} environment has {rules}deployments limited to main")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
