"""The migration files are the pre-deploy step's input (ADR-183): their versions must be unique.

`sqlx migrate run` refuses two files with the same version prefix, which two parallel branches
adding a migration on the same day can produce without a merge conflict (R1, 22 Oct 2026: the
release smoke test on `main` failed in the api's pre-deploy step).
"""

from __future__ import annotations

import collections
import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[3] / "crates" / "db" / "migrations"


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


if __name__ == "__main__":
    unittest.main()
