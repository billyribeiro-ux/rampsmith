"""Unit tests for check_environment.py (ADR-092): the live drill's environment protection check.

Recorded shapes of `GET /repos/{owner}/{repo}/environments/{name}` and
`GET .../deployment-branch-policies`; no network and no token.
"""

from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent


def load() -> Any:
    path = HERE.parent / "check_environment.py"
    spec = importlib.util.spec_from_file_location("check_environment", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load()

PROTECTED: dict[str, Any] = {
    "name": "backup-drill",
    "protection_rules": [{"id": 1, "type": "branch_policy"}],
    "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
}
MAIN_ONLY: dict[str, Any] = {
    "total_count": 1,
    "branch_policies": [{"id": 7, "name": "main", "type": "branch"}],
}


def run(environment: Any, policies: Any) -> tuple[int, str]:
    with tempfile.TemporaryDirectory() as tmp:
        env_file = Path(tmp) / "environment.json"
        pol_file = Path(tmp) / "policies.json"
        env_file.write_text(json.dumps(environment), encoding="utf-8")
        pol_file.write_text(json.dumps(policies), encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            code = check.main(["check_environment.py", str(env_file), str(pol_file)])
        return code, out.getvalue()


class DrillEnvironment(unittest.TestCase):
    def test_limited_to_main_passes(self) -> None:
        code, out = run(PROTECTED, MAIN_ONLY)
        self.assertEqual(code, 0)
        self.assertIn("limited to main", out)

    def test_no_branch_rule_is_refused_and_names_the_row(self) -> None:
        open_environment = {**PROTECTED, "deployment_branch_policy": None}
        code, out = run(open_environment, {"total_count": 0, "branch_policies": []})
        self.assertEqual(code, 1)
        self.assertIn("deployments are not limited to selected branches", out)
        self.assertIn("LAUNCH.md section C row 16", out)

    def test_any_other_branch_or_a_tag_named_main_is_refused(self) -> None:
        for policies in (
            {"branch_policies": [{"name": "main", "type": "branch"}, {"name": "dev", "type": "branch"}]},
            {"branch_policies": [{"name": "release/*", "type": "branch"}]},
            {"branch_policies": [{"name": "main", "type": "tag"}]},
            {"branch_policies": [{"name": "main"}]},
            {"branch_policies": []},
        ):
            code, out = run(PROTECTED, policies)
            self.assertEqual(code, 1, policies)
            self.assertIn("must be exactly main", out)

    def test_only_protected_branches_is_not_enough(self) -> None:
        by_branch_protection = {
            **PROTECTED,
            "deployment_branch_policy": {"protected_branches": True, "custom_branch_policies": False},
        }
        code, _ = run(by_branch_protection, MAIN_ONLY)
        self.assertEqual(code, 1)

    def test_another_environment_is_refused(self) -> None:
        code, out = run({**PROTECTED, "name": "staging"}, MAIN_ONLY)
        self.assertEqual(code, 1)
        self.assertIn("is not called backup-drill", out)

    def test_no_reviewer_is_required(self) -> None:
        # The drill is scheduled; a reviewer gate would hold every run (ADR-092).
        self.assertEqual(check.problems(PROTECTED, MAIN_ONLY), [])

    def test_unreadable_or_malformed_settings_fail_without_a_traceback(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            code = check.main(["check_environment.py", "/nonexistent/a.json", "/nonexistent/b.json"])
        self.assertEqual(code, 1)
        self.assertIn("could not read", out.getvalue())
        code, out_text = run([], MAIN_ONLY)
        self.assertEqual(code, 1)
        self.assertIn("unexpected", out_text)

    def test_usage(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(check.main(["check_environment.py"]), 2)

    def test_messages_never_carry_secret_values(self) -> None:
        # The only inputs are settings JSON; the output is names and the row.
        _, out = run({**PROTECTED, "deployment_branch_policy": None, "token": "sekret-value"}, MAIN_ONLY)
        self.assertNotIn("sekret-value", out)


if __name__ == "__main__":
    unittest.main()
