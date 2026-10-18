"""Refuse a production deploy unless the GitHub environment really requires a reviewer.

PLAN §24 and LAUNCH.md C row 14: production deploys wait for the founder's approval on the
protected `production` environment. GitHub enforces the approval before the job starts, but
only if the founder configured it; an unprotected environment would run the job at once. So
the deploy job reads its own environment (`gh api repos/{owner}/{repo}/environments/{name}`)
and stops before touching Railway unless there is a required-reviewers rule with at least one
reviewer and deployments are limited to protected or selected branches (ADR-185).

Usage: gh api repos/OWNER/REPO/environments/production | python3 check_protection.py
"""

from __future__ import annotations

import json
import sys
from typing import Any


def problems(environment: dict[str, Any]) -> list[str]:
    found: list[str] = []
    rules = environment.get("protection_rules") or []
    reviewers = [
        reviewer
        for rule in rules
        if isinstance(rule, dict) and rule.get("type") == "required_reviewers"
        for reviewer in (rule.get("reviewers") or [])
    ]
    if not reviewers:
        found.append("no required reviewer is configured")
    policy = environment.get("deployment_branch_policy")
    if not isinstance(policy, dict) or not (
        policy.get("protected_branches") or policy.get("custom_branch_policies")
    ):
        found.append("deployments are not limited to protected or selected branches")
    return found


def main() -> int:
    try:
        environment = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("::error title=Production protection::could not read the environment settings")
        return 1
    if not isinstance(environment, dict):
        print("::error title=Production protection::unexpected environment settings")
        return 1
    found = problems(environment)
    name = environment.get("name", "production")
    if found:
        detail = "; ".join(found)
        print(
            f"::error title=Production protection::Refusing to deploy: the {name} environment "
            f"is not protected ({detail}). Configure it as LAUNCH.md C row 14 describes."
        )
        return 1
    print(f"The {name} environment requires a reviewer and is limited to selected branches")
    return 0


if __name__ == "__main__":
    sys.exit(main())
