# Backup and restore hardening: evidence (22 Oct 2026)

Closes the findings of the security re-audit of PR #21 (branch `r1-backup-hardening`; ADR-251 to ADR-259).

| Finding | Fix | Evidence (run locally unless noted) |
| --- | --- | --- |
| HIGH-1 live drill artifact is public | restored cluster only in the container's `/tmp`, deleted there; `restore-local.sh` refuses `--work` inside `--out`; only `report/summary.txt` uploaded; L8 closed by `rd_scrub` | `infra/backup/tests/run.sh`: hand-off test restores through the container and asserts no `PG_VERSION`, `toc.txt`, `restore.dump` or tenant id in `out/`; the summary has only its allow-listed fields |
| M2 restore trusts the newest object | Ed25519-signed metadata, committed public key, future-dated objects rejected, newest by parsed stamp, restore as `rampsmith_migrator`, TOC allow-list | `run.sh` (forged bucket, future stamp, wrong key, tampered signature, TOC and superuser cases); `restore-drill/tests/negative.sh`: 20 cases, 0 failed (tampered-signature, wrong-signing-key, future-backup, foreign-schema, superuser-restore added) |
| MEDIUM-1 image | slim Debian by digest, PGDG client only, no server or gosu; `backup` in the `images` scan matrix; `fail-fast: false` in `release.yml` verify | CI `images (backup)` job (Docker is not available locally) |
| MEDIUM-2 buckets and tokens | one bucket and token per environment, bucket name must end in the environment, `BACKUP_SIGNING_KEY` wired, locks and lifecycle in FOUNDER_SETUP and LAUNCH | `run.sh` bucket-mismatch tests; `infra/railway/tests` (88 tests OK) |
| MEDIUM-3 runbook | uses the `DRILL_R2_*` read-only token and the service logs | `run.sh` asserts each variable a runbook exports is read by a script and each workflow it names exists |
| LOW-1 ADR numbers | ADR-251 to ADR-259; every citation repointed; ADR-174 superseded; README indexed | `grep -rE "ADR-09[0-4]" .github crates infra docs` finds nothing |
| LOW-2 stray environments | LAUNCH row 16 and FOUNDER_SETUP step 6; `drill-strays` job | `infra/restore-drill/tests/test_check_environment.py`: 15 tests OK |
| LOW-3 bytecode | 10 `.pyc` files removed, `.gitignore`, `contracts` step fails on tracked bytecode | CI |
| LOW-4 drill key as plain String | gathered into `Secret` | `cargo clippy -p rampsmith-rsctl --all-targets --all-features --locked -- -D warnings` clean; `cargo test -p rampsmith-rsctl --locked` all pass; `cargo fmt --check` clean |

Known local limits: the five post-quantum recipient tests of `run.sh` fail on the sandbox's age 1.1.1 (they pass on the pinned age 1.3.2 in CI); PostgreSQL 16 stands in for 18 locally.
