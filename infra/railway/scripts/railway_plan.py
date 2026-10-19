"""Read and check a `railway config plan --json` result before anything is applied (ADR-185).

Railway CLI 5.70.0 plans a service whose authoring file declares no source as removing that
service's source (`diff_top_level_field` in src/iac/change_set.rs), and its JSON output keeps
`currentGraph` and `desiredGraph` but drops each change's before and after values. So:

  railway_plan.py current <plan.json>
      prints {"web": "<image or null>", ...}: what each service runs now, so a phase can keep
      it explicitly.
  railway_plan.py phase <current.json> <new.json> <api|all> <name>
      writes <name>.env (the RAMPSMITH_IMAGE_* inputs railway.py reads, one NAME=value per
      line) and <name>.expected.json (the image each service must end up with). Phase `api`
      moves the api alone and keeps every other service, ctl included, on what it runs now;
      phase `all` moves every service to the new release.
  railway_plan.py check <plan.json> <expected.json>
      refuses the plan unless it is ok, has no error diagnostic, every change's kind is one of
      resource.create, resource.update and variable.set (whatever severity Railway gives it)
      and none is labelled destructive or is one of the CLI's destructive updates (a database
      move, a volume resize or detach), every image service's desired source is exactly the
      expected image (null only for a service that has no source yet), and no service loses a
      source it has.
  railway_plan.py applied <applied.json>
      refuses an apply result (`railway config apply --plan ... --json`) unless its status is
      applied or noop and no change failed. CLI 5.70.0 exits 0 on a pinned apply whatever the
      status (src/commands/config/runner.rs), so this is the only check of it.

It never prints the plan itself: the graphs carry variable names and Railway's redacted values.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

IMAGE_SERVICES = ("web", "api", "ctl", "engine", "egress")
REGISTRY = "ghcr.io/billyribeiro-ux"
REPOSITORIES = {
    name: f"{REGISTRY}/rampsmith-{'api' if name == 'ctl' else name}" for name in IMAGE_SERVICES
}
_DIGEST_REF = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9./_-]*)@sha256:[0-9a-f]{64}$")
# The kinds a deploy may apply: CLI 5.70.0's diff emits only these and resource.delete and
# variable.delete (src/iac/change_set.rs). Railway's preview returns the change set that is
# applied, with its own severities, so deletions and any new kind are refused by kind as well;
# a CLI upgrade re-reads change_set.rs (ADR-181).
ALLOWED_KINDS = frozenset({"resource.create", "resource.update", "variable.set"})
# resource.update changes that change_set.rs marks destructive: refused by their summary or
# details too, in case the severity label is missing.
DESTRUCTIVE_UPDATES = ("Move database", "Resize volume", "Detach volume")
APPLIED = frozenset({"applied", "noop"})


def _resources(graph: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(graph, dict):
        return {}
    resources = graph.get("resources")
    if not isinstance(resources, list):
        return {}
    return {
        str(item.get("name")): item
        for item in resources
        if isinstance(item, dict) and item.get("name") is not None
    }


def source_image(resource: dict[str, Any] | None) -> str | None:
    if not resource:
        return None
    source = resource.get("source")
    if isinstance(source, dict) and isinstance(source.get("image"), str) and source["image"]:
        return str(source["image"])
    return None


def has_source(resource: dict[str, Any] | None) -> bool:
    source = resource.get("source") if isinstance(resource, dict) else None
    return isinstance(source, dict) and bool(source)


def current_images(plan: dict[str, Any]) -> dict[str, str | None]:
    current = _resources(plan.get("currentGraph"))
    return {name: source_image(current.get(name)) for name in IMAGE_SERVICES}


def _image(name: str, value: Any, allow_none: bool) -> str | None:
    if value is None and allow_none:
        return None
    match = _DIGEST_REF.fullmatch(value) if isinstance(value, str) else None
    if match is None or match["repository"] != REPOSITORIES[name]:
        raise ValueError(f"{name}: expected {REPOSITORIES[name]}@sha256:<64 hex digits>")
    return str(value)


def phase_inputs(
    current: dict[str, Any], new: dict[str, Any], phase: str
) -> tuple[dict[str, str], dict[str, str | None]]:
    """The railway.py inputs for one phase, and the images the plan must then set."""
    if phase not in ("api", "all"):
        raise ValueError("phase must be api or all")
    now = {name: _image(name, current.get(name), True) for name in IMAGE_SERVICES}
    release = {name: _image(name, new.get(name), False) for name in IMAGE_SERVICES}
    expected = dict(release) if phase == "all" else {**now, "api": release["api"]}
    inputs = {f"RAMPSMITH_IMAGE_{name.upper()}": expected[name] or "" for name in IMAGE_SERVICES}
    return inputs, expected


def problems(plan: dict[str, Any], expected: dict[str, str | None]) -> list[str]:
    found: list[str] = []
    if plan.get("ok") is not True:
        found.append("the plan did not succeed")
    for diagnostic in plan.get("diagnostics") or []:
        if isinstance(diagnostic, dict) and diagnostic.get("severity") == "error":
            found.append(f"diagnostic at {diagnostic.get('path')}: {diagnostic.get('message')}")
    for change in (plan.get("changeSet") or {}).get("changes") or []:
        if not isinstance(change, dict):
            found.append("a change that is not an object")
            continue
        kind = change.get("kind")
        summary = str(change.get("summary") or "")
        if change.get("severity") == "destructive":
            found.append(f"destructive change: {summary}")
        elif kind not in ALLOWED_KINDS:
            found.append(f"change of kind {kind!r} is not one a deploy makes: {summary}")
        elif kind == "resource.update" and (
            summary.startswith(DESTRUCTIVE_UPDATES)
            or "volumeAttachments" in json.dumps(change.get("details"))
        ):
            found.append(f"destructive update: {summary}")
    current = _resources(plan.get("currentGraph"))
    desired = _resources(plan.get("desiredGraph"))
    for name in IMAGE_SERVICES:
        want = expected.get(name)
        have = source_image(current.get(name))
        will = source_image(desired.get(name))
        if will != want:
            found.append(f"{name}: the plan would set its image to {will}, not {want}")
        if has_source(current.get(name)) and not has_source(desired.get(name)):
            found.append(
                f"{name}: the plan would remove its current source ({have or 'not an image'})"
            )
    for name, resource in current.items():
        if name in IMAGE_SERVICES or not has_source(resource):
            continue
        if not has_source(desired.get(name)):
            found.append(f"{name}: the plan would remove its current source")
    return found


def apply_problems(result: Any) -> list[str]:
    if not isinstance(result, dict):
        return ["the apply result is not an object"]
    found: list[str] = []
    status = result.get("status")
    if status not in APPLIED:
        found.append(f"the apply finished with status {status!r}, not applied")
    for change in result.get("changes") or []:
        if isinstance(change, dict) and change.get("status") == "failed":
            name = change.get("summary") or change.get("path") or change.get("kind")
            found.append(f"change failed: {name}")
    for diagnostic in result.get("diagnostics") or []:
        if isinstance(diagnostic, dict) and diagnostic.get("severity") == "error":
            found.append(f"apply diagnostic: {diagnostic.get('message')}")
    return found


def summary(plan: dict[str, Any]) -> list[str]:
    current = _resources(plan.get("currentGraph"))
    desired = _resources(plan.get("desiredGraph"))
    lines = []
    for name in IMAGE_SERVICES:
        before = source_image(current.get(name))
        after = source_image(desired.get(name))
        lines.append(f"{name}: {before or 'none'} -> {after or 'none'}")
    for change in (plan.get("changeSet") or {}).get("changes") or []:
        if isinstance(change, dict):
            lines.append(f"change ({change.get('severity')}): {change.get('summary')}")
    return lines


USAGE = (
    "usage: railway_plan.py current <plan.json> | phase <current.json> <new.json> <api|all> "
    "<name> | check <plan.json> <expected.json> | applied <applied.json>"
)


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] not in ("current", "phase", "check", "applied"):
        print(USAGE)
        return 2
    if argv[1] == "phase":
        if len(argv) != 6:
            print(USAGE)
            return 2
        try:
            inputs, expected = phase_inputs(
                json.loads(Path(argv[2]).read_text(encoding="utf-8")),
                json.loads(Path(argv[3]).read_text(encoding="utf-8")),
                argv[4],
            )
        except (OSError, ValueError, AttributeError) as error:
            print(f"::error title=Railway plan refused::{error}")
            return 1
        Path(f"{argv[5]}.env").write_text(
            "".join(f"{key}={value}\n" for key, value in inputs.items()), encoding="utf-8"
        )
        Path(f"{argv[5]}.expected.json").write_text(json.dumps(expected), encoding="utf-8")
        for name in IMAGE_SERVICES:
            print(f"{argv[5]}: {name} -> {expected[name] or 'none'}")
        return 0
    if argv[1] == "applied":
        try:
            result = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            result = None
        found = apply_problems(result)
        for problem in found:
            print(f"::error title=Railway apply failed::{problem}")
        if not found:
            print(f"Railway applied the plan ({result.get('status')})")
        return 1 if found else 0
    plan = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    if argv[1] == "current":
        print(json.dumps(current_images(plan)))
        return 0
    if len(argv) != 4:
        print("usage: railway_plan.py check <plan.json> <expected.json>")
        return 2
    expected = json.loads(Path(argv[3]).read_text(encoding="utf-8"))
    for line in summary(plan):
        print(line)
    found = problems(plan, expected)
    for problem in found:
        print(f"::error title=Railway plan refused::{problem}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
