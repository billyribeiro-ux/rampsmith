"""Unit tests for the deploy helpers in infra/railway/scripts (ADR-185).

The Node.js guard runs against fake `node` executables here; release.yml also runs it against
real binaries (26.12.0 must be refused, an LTS release accepted). The Railway helpers run
against recorded CLI output shapes (Railway CLI 5.70.0 source, ADR-185), never the network.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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
plan = load("railway_plan")
network = load("ensure_network")


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

    def test_an_lts_release_of_another_line_is_refused(self) -> None:
        """ADR-016 fixes the line at 26; moving it needs the founder."""
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "24.22.0"\n'), self.fake_node("24.22.0", "Krypton")
        )
        self.assertEqual(code, 1)
        self.assertIn("not a 26.x release", out)
        ok, _ = guard.check(
            self.mise('[tools]\nnode = "24.22.0"\n'), self.fake_node("24.22.0", "Krypton"), 24
        )
        self.assertTrue(ok)

    def test_the_binary_must_be_the_pinned_one(self) -> None:
        code, out = self.run_guard(
            self.mise('[tools]\nnode = "26.13.0"\n'), self.fake_node("26.14.0", "Lithium")
        )
        self.assertEqual(code, 1)
        self.assertIn("node on PATH is 26.14.0", out)

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
SINCE = datetime(2026, 10, 18, 10, 1, tzinfo=UTC)


def deployment(ident: str, status: str, created: str, image: str | None) -> dict[str, Any]:
    meta: dict[str, Any] = {"serviceManifest": {"source": {"image": image}}} if image else {}
    return {"id": ident, "status": status, "createdAt": created, "meta": meta}


class WaitForDeployment(unittest.TestCase):
    def run_wait(
        self, pages: list[list[dict[str, Any]]], timeout: float = 30, since: datetime = SINCE
    ) -> tuple[bool, str]:
        calls = iter(pages)
        last = pages[-1]
        now = [0.0]

        def lister(_: str) -> list[dict[str, Any]]:
            return next(calls, last)

        def sleep(seconds: float) -> None:
            now[0] += seconds

        return waiter.wait("api", IMAGE, since, timeout, lister, sleep, lambda: now[0])

    def test_waits_for_the_new_image_to_succeed(self) -> None:
        old = deployment("d1", "SUCCESS", "2026-10-18T10:00:00Z", OTHER)
        ok, message = self.run_wait([
            [old],
            [deployment("d2", "DEPLOYING", "2026-10-18T10:05:00Z", IMAGE), old],
            [deployment("d2", "SUCCESS", "2026-10-18T10:05:00Z", IMAGE), old],
        ])
        self.assertTrue(ok, message)
        self.assertIn("d2", message)
        self.assertIn("SUCCESS", message)

    def test_a_failed_deployment_fails(self) -> None:
        for status in ("FAILED", "CRASHED", "REMOVED", "SKIPPED"):
            with self.subTest(status=status):
                ok, message = self.run_wait(
                    [[deployment("d2", status, "2026-10-18T10:05:00Z", IMAGE)]]
                )
                self.assertFalse(ok)
                self.assertIn(status, message)

    def test_an_older_success_of_the_same_image_is_not_enough(self) -> None:
        """A redeploy of an image that once succeeded must succeed again (L1)."""
        old_same = deployment("d0", "SUCCESS", "2026-10-17T09:00:00Z", IMAGE)
        newer_other = deployment("d1", "SUCCESS", "2026-10-18T09:00:00Z", OTHER)
        ok, message = self.run_wait([[newer_other, old_same]], timeout=600)
        self.assertFalse(ok)
        self.assertIn("timed out", message)
        failing = deployment("d2", "FAILED", "2026-10-18T10:05:00Z", IMAGE)
        ok, message = self.run_wait([[failing, old_same]])
        self.assertFalse(ok)
        self.assertIn("FAILED", message)

    def test_an_unchanged_service_passes_after_the_grace_period(self) -> None:
        running = deployment("d1", "SUCCESS", "2026-10-18T09:00:00Z", IMAGE)
        ok, message = self.run_wait([[running]], timeout=600)
        self.assertTrue(ok, message)
        self.assertIn("unchanged by this apply", message)
        crashed = deployment("d1", "CRASHED", "2026-10-18T09:00:00Z", IMAGE)
        ok, _ = self.run_wait([[crashed]], timeout=600)
        self.assertFalse(ok)

    def test_a_fresh_deployment_of_another_image_never_passes(self) -> None:
        ok, message = self.run_wait(
            [[deployment("d2", "SUCCESS", "2026-10-18T10:05:00Z", OTHER)]], timeout=600
        )
        self.assertFalse(ok)
        self.assertIn("does not run the expected image", message)

    def test_meta_values_are_never_printed(self) -> None:
        secret_meta = {"id": "d2", "status": "SUCCESS", "createdAt": "2026-10-18T10:05:00Z",
                       "meta": {"serviceManifest": {"variables": {"TOKEN": "s3cr3t"}}}}
        ok, message = self.run_wait([[secret_meta]], timeout=10)
        self.assertFalse(ok)
        self.assertNotIn("s3cr3t", message)
        self.assertIn("serviceManifest", message)

    def test_usage(self) -> None:
        with redirect_stdout(io.StringIO()):
            floating = "ghcr.io/x/y:latest"
            self.assertEqual(waiter.main(["w", "api", floating, "2026-10-18T10:00Z"]), 2)
            self.assertEqual(waiter.main(["w", "api", IMAGE, "yesterday"]), 2)
            self.assertEqual(waiter.main(["w", "api", IMAGE]), 2)


def environment(name: str, reviewers: int, custom: bool | None) -> dict[str, Any]:
    rules: list[dict[str, Any]] = [{"type": "branch_policy"}]
    if reviewers >= 0:
        rules.append({"type": "required_reviewers",
                      "reviewers": [{"type": "User", "reviewer": {}}] * reviewers})
    policy = None if custom is None else {"protected_branches": not custom,
                                          "custom_branch_policies": custom}
    return {"name": name, "protection_rules": rules, "deployment_branch_policy": policy}


def policies(*names: tuple[str, str]) -> dict[str, Any]:
    return {"total_count": len(names),
            "branch_policies": [{"id": i, "name": n, "type": t} for i, (n, t) in enumerate(names)]}


MAIN_ONLY = policies(("main", "branch"))


class EnvironmentProtection(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())

    def check(self, env: dict[str, Any], branch_policies: dict[str, Any],
              reviewer: bool) -> tuple[int, str]:
        env_file = self.dir / "environment.json"
        policy_file = self.dir / "policies.json"
        env_file.write_text(json.dumps(env), encoding="utf-8")
        policy_file.write_text(json.dumps(branch_policies), encoding="utf-8")
        argv = ["check", str(env_file), str(policy_file)]
        if reviewer:
            argv.append("--require-reviewer")
        out = io.StringIO()
        with redirect_stdout(out):
            code = protection.main(argv)
        return code, out.getvalue()

    def test_protected_environments_pass(self) -> None:
        code, out = self.check(environment("production", 1, True), MAIN_ONLY, True)
        self.assertEqual(code, 0, out)
        code, out = self.check(environment("staging", -1, True), MAIN_ONLY, False)
        self.assertEqual(code, 0, out)

    def test_production_without_a_reviewer_is_refused(self) -> None:
        for reviewers in (-1, 0):
            with self.subTest(reviewers=reviewers):
                code, out = self.check(environment("production", reviewers, True), MAIN_ONLY, True)
                self.assertEqual(code, 1)
                self.assertIn("no required reviewer", out)

    def test_any_branch_or_protected_branches_are_refused(self) -> None:
        for custom in (None, False):
            with self.subTest(custom=custom):
                code, out = self.check(environment("staging", -1, custom), MAIN_ONLY, False)
                self.assertEqual(code, 1)
                self.assertIn("not limited to selected branches", out)

    def test_only_main_may_be_selected(self) -> None:
        for selected in (
            policies(),
            policies(("main", "branch"), ("release/*", "branch")),
            policies(("*", "branch")),
            policies(("main", "tag")),
            policies(("mai*", "branch")),
            {"branch_policies": [{"id": 1, "name": "main"}]},  # no type: never read as a branch
        ):
            with self.subTest(selected=selected):
                code, out = self.check(environment("production", 1, True), selected, True)
                self.assertEqual(code, 1)
                self.assertIn("must be exactly main", out)

    def test_unreadable_settings_are_refused(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(protection.main(["check", "/nonexistent", "/nonexistent"]), 1)
            self.assertEqual(protection.main(["check"]), 2)


def graph(images: dict[str, str | None]) -> dict[str, Any]:
    resources: list[dict[str, Any]] = [{"name": "postgres", "type": "database"}]
    for name, image in images.items():
        resource: dict[str, Any] = {"name": name, "type": "service"}
        if image:
            resource["source"] = {"type": "image", "image": image}
        resources.append(resource)
    return {"name": "rampsmith", "resources": resources}


def images(fill: str) -> dict[str, str | None]:
    return {
        name: f"ghcr.io/billyribeiro-ux/rampsmith-{ {'ctl': 'api', 'mailer': 'engine'}.get(name, name)}@sha256:"
        + fill * 32
        for name in ("web", "api", "ctl", "engine", "mailer", "egress", "backup")
    }


NEW = images("ab")
NOW = images("cd")


def a_plan(current: dict[str, str | None], desired: dict[str, str | None],
           changes: list[dict[str, Any]] | None = None, ok: bool = True,
           diagnostics: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"ok": ok, "changeSet": {"changes": changes or []},
            "diagnostics": diagnostics or [], "currentGraph": graph(current),
            "desiredGraph": graph(desired)}


class RailwayPlan(unittest.TestCase):
    def test_current_reads_the_running_images(self) -> None:
        current = {**NOW, "egress": None}
        self.assertEqual(plan.current_images(a_plan(current, NEW)), current)

    def test_a_plan_that_sets_exactly_the_expected_images_passes(self) -> None:
        self.assertEqual(plan.problems(a_plan(NOW, NEW), NEW), [])
        phase_one = {**NOW, "api": NEW["api"]}
        self.assertEqual(plan.problems(a_plan(NOW, phase_one), phase_one), [])
        first = dict.fromkeys(NEW)
        self.assertEqual(plan.problems(a_plan(first, NEW), NEW), [])

    def test_a_dropped_or_unexpected_source_is_refused(self) -> None:
        dropped = {**NEW, "web": None}
        found = plan.problems(a_plan(NOW, dropped), NEW)
        self.assertTrue(any("remove its current source" in p for p in found), found)
        found = plan.problems(a_plan(NOW, NEW), {**NOW, "api": NEW["api"]})
        self.assertTrue(any("web: the plan would set its image" in p for p in found), found)

    def test_a_non_image_source_counts_as_a_source(self) -> None:
        body = a_plan(NOW, NEW)
        body["currentGraph"]["resources"][1]["source"] = {"type": "github", "repo": "x/y"}
        body["desiredGraph"]["resources"][1].pop("source")
        found = plan.problems(body, {**NEW, "web": None})
        self.assertTrue(any("web: the plan would remove its current source" in p for p in found))
        body = a_plan(NOW, NEW)
        body["currentGraph"]["resources"][0]["source"] = {"type": "image", "image": "x"}
        found = plan.problems(body, NEW)
        self.assertTrue(any("postgres: the plan would remove" in p for p in found), found)

    def test_phase_api_moves_only_the_api(self) -> None:
        inputs, expected = plan.phase_inputs(NOW, NEW, "api")
        self.assertEqual(expected, {**NOW, "api": NEW["api"]})
        self.assertEqual(inputs["RAMPSMITH_IMAGE_API"], NEW["api"])
        self.assertEqual(inputs["RAMPSMITH_IMAGE_CTL"], NOW["ctl"])
        self.assertEqual(inputs["RAMPSMITH_IMAGE_WEB"], NOW["web"])

    def test_the_first_deploy_starts_with_the_api_alone(self) -> None:
        inputs, expected = plan.phase_inputs(dict.fromkeys(NEW), NEW, "api")
        self.assertEqual(expected, {**dict.fromkeys(NEW), "api": NEW["api"]})
        # Set but empty: railway.py then gives ctl no source instead of the api's image.
        self.assertEqual(inputs["RAMPSMITH_IMAGE_CTL"], "")

    def test_phase_all_moves_everything(self) -> None:
        inputs, expected = plan.phase_inputs(NOW, NEW, "all")
        self.assertEqual(expected, NEW)
        self.assertEqual(set(inputs.values()), set(NEW.values()))

    def test_phase_inputs_are_validated(self) -> None:
        for current, new, phase in (
            (NOW, {**NEW, "web": None}, "all"),
            (NOW, {**NEW, "ctl": NEW["web"]}, "all"),
            ({**NOW, "api": "ghcr.io/billyribeiro-ux/rampsmith-api:latest"}, NEW, "api"),
            (NOW, NEW, "web"),
        ):
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                plan.phase_inputs(current, new, phase)

    def test_phase_writes_an_env_file(self) -> None:
        directory = Path(tempfile.mkdtemp())
        (directory / "current.json").write_text(json.dumps(NOW), encoding="utf-8")
        (directory / "new.json").write_text(json.dumps(NEW), encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            code = plan.main(["p", "phase", str(directory / "current.json"),
                              str(directory / "new.json"), "api", str(directory / "phase1")])
        self.assertEqual(code, 0)
        lines = (directory / "phase1.env").read_text(encoding="utf-8").splitlines()
        self.assertIn(f"RAMPSMITH_IMAGE_API={NEW['api']}", lines)
        self.assertIn(f"RAMPSMITH_IMAGE_CTL={NOW['ctl']}", lines)
        expected = json.loads((directory / "phase1.expected.json").read_text(encoding="utf-8"))
        self.assertEqual(expected["web"], NOW["web"])

    def test_changes_are_refused_by_kind_whatever_their_severity(self) -> None:
        for change in (
            {"kind": "variable.delete", "summary": "delete RAMPSMITH_MASTER_KEYS"},
            {"kind": "resource.delete", "summary": "delete postgres", "severity": "safe"},
            {"kind": "volume.detach", "summary": "detach data", "severity": "safe"},
            {"kind": "resource.replace", "summary": "?", "severity": "safe"},
            {"summary": "no kind", "severity": "safe"},
        ):
            with self.subTest(change=change):
                self.assertTrue(plan.problems(a_plan(NOW, NEW, changes=[change]), NEW))
        allowed = [{"kind": kind, "summary": kind, "severity": "safe"}
                   for kind in ("resource.create", "resource.update", "variable.set")]
        self.assertEqual(plan.problems(a_plan(NOW, NEW, changes=allowed), NEW), [])
        # Kinds the CLI does not emit today stop for a human, even if they look harmless.
        for kind in ("domain.create", "tcpproxy.create", "volume.create", "service.create"):
            with self.subTest(kind=kind):
                change = {"kind": kind, "summary": kind, "severity": "safe"}
                self.assertTrue(plan.problems(a_plan(NOW, NEW, changes=[change]), NEW))

    def test_destructive_updates_are_refused_without_their_label(self) -> None:
        for change in (
            {"kind": "resource.update", "summary": "Move database postgres to eu-west4"},
            {"kind": "resource.update", "summary": "Resize volume data from 5000MB to 500MB"},
            {"kind": "resource.update", "summary": "Update web volumeAttachments",
             "details": ["volumeAttachments.data"]},
        ):
            with self.subTest(change=change):
                self.assertTrue(plan.problems(a_plan(NOW, NEW, changes=[change]), NEW))

    def test_an_apply_must_report_applied(self) -> None:
        self.assertEqual(plan.apply_problems({"status": "applied", "changes": [
            {"kind": "resource.update", "summary": "web", "status": "applied"}]}), [])
        self.assertEqual(plan.apply_problems({"id": None, "status": "noop", "changes": []}), [])
        for result in (
            {"status": "failed", "changes": []},
            {"status": "partially_applied", "changes": []},
            {"status": "staged", "changes": []},
            {"status": "applied", "changes": [{"summary": "Set API_URL", "status": "failed"}]},
            {"status": "applied", "diagnostics": [{"severity": "error", "message": "x"}]},
            {"changes": []},
            None,
        ):
            with self.subTest(result=result):
                self.assertTrue(plan.apply_problems(result))

    def test_applied_never_prints_outputs(self) -> None:
        directory = Path(tempfile.mkdtemp())
        path = directory / "applied.json"
        path.write_text(json.dumps({"status": "failed", "changes": [
            {"summary": "Set X", "status": "failed", "outputs": {"value": "s3cr3t"}}]}),
            encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(plan.main(["p", "applied", str(path)]), 1)
        self.assertNotIn("s3cr3t", out.getvalue())
        self.assertIn("change failed: Set X", out.getvalue())

    def test_destructive_changes_errors_and_failures_are_refused(self) -> None:
        destructive = [{"summary": "delete service ctl", "severity": "destructive",
                        "kind": "delete"}]
        self.assertTrue(plan.problems(a_plan(NOW, NEW, changes=destructive), NEW))
        error = [{"severity": "error", "path": "resources[1]", "message": "bad"}]
        self.assertTrue(plan.problems(a_plan(NOW, NEW, diagnostics=error), NEW))
        self.assertTrue(plan.problems(a_plan(NOW, NEW, ok=False), NEW))
        warning = [{"severity": "warning", "path": "x", "message": "fine"}]
        self.assertEqual(plan.problems(a_plan(NOW, NEW, diagnostics=warning), NEW), [])

    def test_main_never_prints_variables(self) -> None:
        directory = Path(tempfile.mkdtemp())
        body = a_plan(NOW, NEW)
        body["desiredGraph"]["resources"][1]["variables"] = {"TOKEN": {"value": "s3cr3t"}}
        (directory / "plan.json").write_text(json.dumps(body), encoding="utf-8")
        (directory / "expected.json").write_text(json.dumps(NEW), encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            code = plan.main(["p", "check", str(directory / "plan.json"),
                              str(directory / "expected.json")])
            plan.main(["p", "current", str(directory / "plan.json")])
        self.assertEqual(code, 0, out.getvalue())
        self.assertNotIn("s3cr3t", out.getvalue())


class FakeRailway:
    """Answers `railway tcp-proxy list`, `domain list|status|update` and `domain <host>` from
    an in-memory state shaped like Railway CLI 5.70.0's --json output."""

    def __init__(self, domains: dict[str, list[dict[str, Any]]],
                 proxies: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.domains = domains
        self.proxies = proxies or {}
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]) -> Any:
        self.calls.append(args)
        service = args[args.index("--service") + 1]
        if args[:2] == ["tcp-proxy", "list"]:
            return {"proxies": self.proxies.get(service, [])}
        if args[:2] == ["domain", "list"]:
            return {"domains": self.domains.get(service, [])}
        if args[:2] == ["domain", "status"]:
            return {"domain": {"domain": args[2], "dnsRecords": [
                {"recordType": "CNAME", "fqdn": args[2], "requiredValue": "x.up.railway.app"}]}}
        if args[:2] == ["domain", "update"]:
            for item in self.domains.get(service, []):
                if item["domain"] == args[2]:
                    item["targetPort"] = int(args[args.index("--port") + 1])
            return {}
        if args[0] == "domain":
            port = int(args[args.index("--port") + 1])
            self.domains.setdefault(service, []).append(
                {"id": "new", "domain": args[1], "type": "custom", "targetPort": port})
            return {}
        raise AssertionError(f"unexpected call {args}")


def custom(name: str, port: int | None) -> dict[str, Any]:
    return {"id": name, "domain": name, "type": "custom", "targetPort": port,
            "syncStatus": "ACTIVE"}


HOSTS = {"RAMPSMITH_APP_HOST": "app.rampsmith.example",
         "RAMPSMITH_SITE_HOST": "rampsmith.example",
         "RAMPSMITH_WEBHOOK_HOST": "hooks.rampsmith.example"}


class EnsureNetwork(unittest.TestCase):
    def setUp(self) -> None:
        self.module = network.load_railway()
        self.wanted = network.expected_domains(self.module, HOSTS)

    def run_all(self, fake: FakeRailway, create: bool) -> tuple[list[str], list[str]]:
        problems: list[str] = []
        notes: list[str] = []
        for service in self.module.SERVICES:
            found, said = network.check_service(
                service, "staging", self.wanted.get(service, {}), create, fake
            )
            problems += found
            notes += said
        return problems, notes

    def test_expected_domains_follow_public(self) -> None:
        self.assertEqual(self.wanted, {
            "web": {"app.rampsmith.example": 3000, "rampsmith.example": 3000},
            "api": {"hooks.rampsmith.example": 8081},
        })
        self.assertEqual(network.expected_domains(self.module, {}), {})
        with self.assertRaises(ValueError):
            network.expected_domains(self.module, {"RAMPSMITH_WEBHOOK_HOST": "https://x.example"})

    def test_missing_domains_are_created_with_their_ports(self) -> None:
        fake = FakeRailway({})
        problems, notes = self.run_all(fake, create=True)
        self.assertEqual(problems, [])
        self.assertIn(["domain", "hooks.rampsmith.example", "--port", "8081", "--service", "api",
                       "--environment", "staging"], fake.calls)
        self.assertTrue(any("DNS for app.rampsmith.example" in n for n in notes))
        # A second pass in verify mode finds everything in place.
        problems, _ = self.run_all(fake, create=False)
        self.assertEqual(problems, [])

    def test_verify_mode_never_changes_anything(self) -> None:
        fake = FakeRailway({"web": [custom("app.rampsmith.example", 8080)]})
        problems, _ = self.run_all(fake, create=False)
        self.assertTrue(any("targets port 8080, not 3000" in p for p in problems), problems)
        self.assertTrue(any("missing its custom domain rampsmith.example" in p for p in problems))
        changes = [c for c in fake.calls if c[1] not in ("list",) and c[0] == "domain"]
        self.assertEqual(changes, [])

    def test_a_wrong_port_is_corrected_and_still_fails(self) -> None:
        """Until the correction the webhook host reached the api's private API."""
        fake = FakeRailway({"api": [custom("hooks.rampsmith.example", 8080)]})
        problems, notes = self.run_all(fake, create=True)
        self.assertTrue(any("targeted port 8080, not 8081" in p for p in problems), problems)
        self.assertIn(["domain", "update", "hooks.rampsmith.example", "--port", "8081",
                       "--service", "api", "--environment", "staging"], fake.calls)
        self.assertTrue(any("now targets port 8081" in n for n in notes))
        problems, _ = self.run_all(fake, create=False)
        self.assertFalse(any("hooks.rampsmith.example" in p for p in problems), problems)

    def test_other_exposure_is_refused_and_never_deleted(self) -> None:
        fake = FakeRailway(
            {"ctl": [{"id": "g", "domain": "ctl-production.up.railway.app", "type": "service",
                      "targetPort": 8080}],
             "web": [custom("app.rampsmith.example", 3000), custom("rampsmith.example", 3000),
                     custom("old.rampsmith.example", 3000)]},
            proxies={"postgres": [{"id": "p", "domain": "x.proxy.rlwy.net", "proxyPort": 1234,
                                   "applicationPort": 5432}]},
        )
        problems, _ = self.run_all(fake, create=True)
        joined = "\n".join(problems)
        self.assertIn("ctl has a Railway-generated domain", joined)
        self.assertIn("unexpected custom domain old.rampsmith.example", joined)
        self.assertIn("postgres has a public TCP proxy", joined)
        self.assertFalse([c for c in fake.calls if "delete" in c])


WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def steps(workflow: str) -> list[tuple[str, list[str]]]:
    """Each `uses:` step of a workflow with its lines, read as text (no YAML parser needed)."""
    lines = (WORKFLOWS / workflow).read_text(encoding="utf-8").splitlines()
    found: list[tuple[str, list[str]]] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not (stripped.startswith("- uses:") or stripped.startswith("uses:")):
            continue
        indent = len(line) - len(line.lstrip(" - "))
        body = [line]
        for following in lines[index + 1:]:
            if following.strip() and (len(following) - len(following.lstrip())) < indent:
                break
            if following.lstrip().startswith("- "):
                break
            body.append(following)
        found.append((stripped.split("uses:", 1)[1].strip(), body))
    return found


def job(workflow: str, name: str) -> str:
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    start = text.index(f"\n  {name}:\n")
    end = text.find("\n  ", start + 1)
    while end != -1 and text[end + 3] == " ":
        end = text.find("\n  ", end + 1)
    return text[start:] if end == -1 else text[start:end]


class WorkflowHygiene(unittest.TestCase):
    """What the security reviews of release.yml and deploy.yml require, checked on every run."""

    FILES = ("release.yml", "deploy.yml")

    def test_actions_are_pinned_by_commit(self) -> None:
        for workflow in self.FILES:
            for uses, _ in steps(workflow):
                with self.subTest(workflow=workflow, uses=uses):
                    if uses.startswith("./"):
                        continue
                    self.assertRegex(uses, r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}(\s+#.*)?$")

    def test_no_shared_tool_cache(self) -> None:
        for workflow in self.FILES:
            for uses, body in steps(workflow):
                text = "\n".join(body)
                with self.subTest(workflow=workflow, uses=uses):
                    self.assertFalse(uses.startswith("actions/cache"))
                    if uses.startswith("jdx/mise-action"):
                        self.assertIn("cache: false", text)

    def test_the_signing_build_reads_no_cache(self) -> None:
        publish = job("release.yml", "publish")
        self.assertIn("id-token: write", publish)
        self.assertNotIn("cache-from", publish)
        self.assertNotIn("cache-to", publish)

    def test_buildkit_is_pinned_by_digest(self) -> None:
        text = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
        self.assertRegex(text, r"\n  BUILDKIT_IMAGE: moby/buildkit:v[\d.]+@sha256:[0-9a-f]{64}\n")
        buildx = [body for uses, body in steps("release.yml")
                  if uses.startswith("docker/setup-buildx-action")]
        self.assertTrue(buildx)
        for body in buildx:
            text = "\n".join(body)
            self.assertIn("driver-opts: image=${{ env.BUILDKIT_IMAGE }}", text)
            self.assertIn("cache-binary: false", text)

    def test_no_floating_tags(self) -> None:
        for workflow in self.FILES:
            text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
            with self.subTest(workflow=workflow):
                self.assertNotRegex(text, r":latest\b")


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
