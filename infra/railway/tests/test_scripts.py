"""Unit tests for the deploy helpers in infra/railway/scripts (ADR-185).

The Node.js guard runs against fake `node` executables here; release.yml also runs it against
the real pinned binaries (26.12.0 must be refused, an LTS release accepted).
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


def load(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load("node_lts_guard")
waiter = load("wait_for_deployment")
protection = load("check_protection")


class NodeLtsGuard(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())

    def mise(self, body: str) -> Path:
        path = self.dir / ".mise.toml"
        path.write_text(body, encoding="utf-8")
        return path

    def fake_node(self, version: str, lts: str) -> str:
        path = self.dir / "node"
        path.write_text(
            "#!/bin/sh\n" f"printf '%s\\n%s' 'v{version}' '{lts}'\n", encoding="utf-8"
        )
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return str(path)

    def run_guard(self, mise_toml: Path, node: str) -> tuple[int, str]:
        out = io.StringIO()
        with redirect_stdout(out):
            code = guard.main(["guard", str(mise_toml), node])
        return code, out.getvalue()

    def test_a_current_release_is_refused(self) -> None:
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "26.12.0"\n'), self.fake_node("26.12.0", "")
        )
        self.assertEqual(code, 1)
        self.assertIn("::error", out)
        self.assertIn("not a release tagged LTS", out)

    def test_an_lts_release_passes(self) -> None:
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "26.13.0"\npnpm = "12.14.0"\n'),
            self.fake_node("26.13.0", "Lithium"),
        )
        self.assertEqual(code, 0, out)
        self.assertIn("Lithium", out)

    def test_the_binary_must_be_the_pinned_one(self) -> None:
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "26.13.0"\n'), self.fake_node("24.22.0", "Krypton")
        )
        self.assertEqual(code, 1)
        self.assertIn("node on PATH is 24.22.0", out)

    def test_a_table_pin_is_read(self) -> None:
        code, _ = self.run_guard(
            self.mise('[tools]\nnode = { version = "26.13.0" }\n'),
            self.fake_node("26.13.0", "Lithium"),
        )
        self.assertEqual(code, 0)

    def test_a_missing_pin_or_binary_is_refused(self) -> None:
        code, out = self.run_guard(self.mise("[tools]\n"), self.fake_node("26.13.0", "Lithium"))
        self.assertEqual(code, 1)
        self.assertIn("no [tools] node pin", out)
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "26.13.0"\n'), str(self.dir / "missing")
        )
        self.assertEqual(code, 1)

    def test_the_repository_pin_is_readable(self) -> None:
        root = Path(__file__).resolve().parents[3]
        self.assertRegex(guard.pinned_node(root / ".mise.toml"), r"^26\.\d+\.\d+$")


IMAGE = "ghcr.io/billyribeiro-ux/rampsmith-api@sha256:" + "ab" * 32
OTHER = "ghcr.io/billyribeiro-ux/rampsmith-api@sha256:" + "cd" * 32


def deployment(ident: str, status: str, created: str, image: str | None) -> dict[str, Any]:
    meta: dict[str, Any] = {"serviceManifest": {"source": {"image": image}}} if image else {}
    return {"id": ident, "status": status, "createdAt": created, "meta": meta}


class WaitForDeployment(unittest.TestCase):
    def run_wait(self, pages: list[list[dict[str, Any]]], timeout: float = 30) -> tuple[bool, str]:
        calls = iter(pages)
        last = pages[-1]
        now = [0.0]

        def lister(_: str) -> list[dict[str, Any]]:
            return next(calls, last)

        def sleep(seconds: float) -> None:
            now[0] += seconds

        return waiter.wait("api", IMAGE, timeout, lister, sleep, lambda: now[0])

    def test_waits_for_the_new_image_to_succeed(self) -> None:
        old = deployment("d1", "SUCCESS", "2026-10-18T10:00:00Z", OTHER)
        ok, message = self.run_wait([
            [old],
            [deployment("d2", "DEPLOYING", "2026-10-18T10:05:00Z", IMAGE), old],
            [deployment("d2", "SUCCESS", "2026-10-18T10:05:00Z", IMAGE), old],
        ])
        self.assertTrue(ok, message)
        self.assertIn("d2 is SUCCESS", message)

    def test_a_failed_deployment_fails(self) -> None:
        ok, message = self.run_wait([[deployment("d2", "FAILED", "2026-10-18T10:05:00Z", IMAGE)]])
        self.assertFalse(ok)
        self.assertIn("FAILED", message)

    def test_the_old_image_succeeding_is_not_enough(self) -> None:
        ok, message = self.run_wait([[deployment("d1", "SUCCESS", "2026-10-18T10:00:00Z", OTHER)]])
        self.assertFalse(ok)
        self.assertIn("timed out", message)
        self.assertIn("does not run the expected image", message)

    def test_meta_values_are_never_printed(self) -> None:
        secret_meta = {"id": "d1", "status": "SUCCESS", "createdAt": "x",
                       "meta": {"serviceManifest": {"variables": {"TOKEN": "s3cr3t"}}}}
        ok, message = self.run_wait([[secret_meta]], timeout=10)
        self.assertFalse(ok)
        self.assertNotIn("s3cr3t", message)
        self.assertIn("serviceManifest", message)

    def test_usage_requires_a_digest(self) -> None:
        with redirect_stdout(io.StringIO()):
            self.assertEqual(waiter.main(["w", "api", "ghcr.io/x/y:latest"]), 2)


class ProductionProtection(unittest.TestCase):
    PROTECTED = {
        "name": "production",
        "protection_rules": [
            {"type": "wait_timer", "wait_timer": 0},
            {"type": "required_reviewers", "reviewers": [{"type": "User", "reviewer": {}}]},
            {"type": "branch_policy"},
        ],
        "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
    }

    def check(self, environment: dict[str, Any]) -> tuple[int, str]:
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(environment))), \
                redirect_stdout(out):
            code = protection.main()
        return code, out.getvalue()

    def test_a_protected_environment_passes(self) -> None:
        code, out = self.check(self.PROTECTED)
        self.assertEqual(code, 0, out)

    def test_no_reviewer_is_refused(self) -> None:
        unprotected = {**self.PROTECTED, "protection_rules": [{"type": "branch_policy"}]}
        code, out = self.check(unprotected)
        self.assertEqual(code, 1)
        self.assertIn("no required reviewer", out)
        empty = {**self.PROTECTED, "protection_rules": [{"type": "required_reviewers",
                                                          "reviewers": []}]}
        self.assertEqual(self.check(empty)[0], 1)

    def test_any_branch_is_refused(self) -> None:
        code, out = self.check({**self.PROTECTED, "deployment_branch_policy": None})
        self.assertEqual(code, 1)
        self.assertIn("not limited", out)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
