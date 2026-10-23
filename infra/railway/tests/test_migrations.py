"""The migration files are the pre-deploy step's input (ADR-183): their versions must be unique.

`sqlx migrate run` refuses two files with the same version prefix, which two parallel branches
adding a migration on the same day can produce without a merge conflict (R1, 22 Oct 2026: the
release smoke test on `main` failed in the api's pre-deploy step).
"""

from __future__ import annotations

import collections
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "crates" / "db" / "migrations"
RELATIVE = "crates/db/migrations"


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def edited_existing_migrations(repo: Path, base_ref: str) -> list[str] | None:
    """Migration files that exist at the merge base with `base_ref` and are modified, renamed or
    deleted in HEAD (`name-status` lines). `None` when there is nothing to compare: the base is
    not fetched, or HEAD is the base (a push to main, which the pull request already checked).

    A migration that has been applied anywhere (`_sqlx_migrations` stores its checksum) must
    never change: `sqlx migrate run` refuses a changed file, and a renamed one is applied again
    under its new version. Two pull requests that are each green against the old main can
    otherwise break main together (R1, 22 Oct 2026).
    """
    try:
        base = git(repo, "merge-base", "HEAD", base_ref)
        head = git(repo, "rev-parse", "HEAD")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if base == head:
        return None
    # --no-renames makes a rename a delete plus an add, so the old name is reported.
    changes = git(
        repo, "diff", "--name-status", "--no-renames", base, "HEAD", "--", RELATIVE
    ).splitlines()
    return [line for line in changes if not line.startswith("A\t")]


class MigrationVersions(unittest.TestCase):
    def test_versions_are_unique_and_named_the_way_sqlx_reads_them(self) -> None:
        files = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
        self.assertTrue(files, "no migrations found")
        versions: collections.defaultdict[str, list[str]] = collections.defaultdict(list)
        for name in files:
            match = re.fullmatch(r"(\d{14})_[a-z0-9_]+\.sql", name)
            self.assertIsNotNone(match, f"{name} is not <14-digit version>_<name>.sql")
            assert match is not None
            versions[match.group(1)].append(name)
        duplicated = {v: names for v, names in versions.items() if len(names) > 1}
        self.assertEqual(duplicated, {}, "two migrations share a version")


class MigrationsAreImmutable(unittest.TestCase):
    def test_no_migration_that_exists_on_main_is_edited_renamed_or_deleted(self) -> None:
        # CI fetches origin/main (release.yml `config` job); locally it may be missing.
        base_ref = os.environ.get("RAMPSMITH_MIGRATION_BASE", "origin/main")
        edited = edited_existing_migrations(ROOT, base_ref)
        if edited is None:
            if os.environ.get("CI") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
                self.fail(f"{base_ref} is not available to compare migrations against")
            self.skipTest(f"{base_ref} is not available, or HEAD is the base")
        self.assertEqual(
            edited,
            [],
            "migrations already on main must never change; add a new migration instead",
        )

    def test_the_check_reports_each_kind_of_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-q", "-b", "main")
            git(repo, "config", "user.email", "ci@example.invalid")
            git(repo, "config", "user.name", "ci")
            git(repo, "config", "commit.gpgsign", "false")
            folder = repo / RELATIVE
            folder.mkdir(parents=True)
            for name in ("20260101000001_a.sql", "20260101000002_b.sql", "20260101000003_c.sql"):
                (folder / name).write_text(f"-- {name}\n")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "base")
            git(repo, "switch", "-q", "-c", "topic")
            self.assertIsNone(edited_existing_migrations(repo, "main"), "HEAD is the base")
            (folder / "20260101000004_d.sql").write_text("-- new\n")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "add")
            self.assertEqual(edited_existing_migrations(repo, "main"), [])
            (folder / "20260101000001_a.sql").write_text("-- edited\n")
            git(repo, "mv", RELATIVE + "/20260101000002_b.sql", RELATIVE + "/20260101000009_b.sql")
            git(repo, "rm", "-q", RELATIVE + "/20260101000003_c.sql")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "tamper")
            changes = edited_existing_migrations(repo, "main") or []
            self.assertEqual(
                sorted(changes),
                sorted(
                    [
                        f"M\t{RELATIVE}/20260101000001_a.sql",
                        f"D\t{RELATIVE}/20260101000002_b.sql",
                        f"D\t{RELATIVE}/20260101000003_c.sql",
                    ]
                ),
            )
            self.assertIsNone(edited_existing_migrations(repo, "origin/missing"))


if __name__ == "__main__":
    unittest.main()
