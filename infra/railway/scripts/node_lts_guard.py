"""Refuse a deploy unless .mise.toml pins a Node.js release tagged LTS (ADR-185).

CLAUDE.md and ADR-016: releases may merge on Node 26.12.0, but nothing deploys before the pins
move to the first 26.x release tagged LTS. A release counts as LTS when `process.release.lts`
prints a codename, so this runs the pinned binary instead of trusting a version table.

Usage: python3 node_lts_guard.py [path/to/.mise.toml] [node executable]
Exit 0 and print the codename when the pin is LTS; exit 1 with a GitHub error annotation
otherwise (including when the `node` on PATH is not the pinned version).
"""

from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path


def pinned_node(mise_toml: Path) -> str:
    with mise_toml.open("rb") as handle:
        config = tomllib.load(handle)
    value = config.get("tools", {}).get("node")
    if isinstance(value, dict):
        value = value.get("version")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{mise_toml} has no [tools] node pin")
    return value.strip()


def node_release(node: str) -> tuple[str, str]:
    """The binary's version (without the leading v) and its LTS codename, empty if none."""
    script = "process.stdout.write(process.version + '\\n' + (process.release.lts ?? ''))"
    output = subprocess.run(
        [node, "-e", script], capture_output=True, text=True, check=True, timeout=60
    ).stdout
    version, _, lts = output.partition("\n")
    return version.strip().removeprefix("v"), lts.strip()


def check(mise_toml: Path, node: str) -> tuple[bool, str]:
    pinned = pinned_node(mise_toml)
    version, lts = node_release(node)
    if version != pinned:
        return False, f"node on PATH is {version}, but {mise_toml} pins {pinned}"
    if not lts:
        return False, (
            f"{mise_toml} pins Node.js {pinned}, which is not a release tagged LTS "
            "(process.release.lts is empty). Nothing deploys before the 26.x LTS pin "
            "(CLAUDE.md, ADR-016)."
        )
    return True, f"Node.js {pinned} is an LTS release ({lts})"


def main(argv: list[str]) -> int:
    mise_toml = Path(argv[1]) if len(argv) > 1 else Path(".mise.toml")
    node = argv[2] if len(argv) > 2 else "node"
    try:
        ok, message = check(mise_toml, node)
    except (OSError, ValueError, subprocess.SubprocessError, tomllib.TOMLDecodeError) as error:
        ok, message = False, f"could not check the Node.js pin: {error}"
    if ok:
        print(message)
        return 0
    print(f"::error title=Node.js LTS guard::{message}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
