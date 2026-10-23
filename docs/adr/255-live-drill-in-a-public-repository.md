# ADR-255: The live restore drill hands nothing but a summary to a public repository

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Closes finding HIGH-1 and L8 of the 22 Oct 2026 re-audit; refines ADR-175

## Context

The repository is public, so workflow logs and artifacts are public. The first live drill restored the newest backup into a cluster under the scratch directory and uploaded `out/` as an artifact: the restored data directory, the archive table of contents and per-tenant names would have been downloadable by anyone, for 30 days. GitHub: artifacts of public repositories are readable by anyone who can see the run (GitHub docs, "Storing and sharing data from a workflow").

## Decision

- The restored cluster is made in the drill container's own `/tmp/rd-restore` and deleted inside the container (`restore-local.sh --discard-work`, `RD_DISCARD_DIRS` in `container-run.sh`). It is never on the runner's disk and never uploaded.
- `restore-local.sh` refuses `--work` inside `--out`, `--out` inside `--work`, or the same directory.
- Container output goes to a log that `rd_scrub` rewrites (UUIDs become `<id>`, database message lines are withheld) before anything is printed.
- The only uploaded file is `report/summary.txt`: result, backup date, durations, counts. The test in `infra/backup/tests/run.sh` runs a live hand-off end to end and fails if `out/` holds `PG_VERSION`, `toc.txt`, `restore.dump` or a tenant id.
- The drill reads staging only (ADR-252).

## Consequences

A weekly proof of restore with no customer data leaving the runner.

## Rejected alternatives

- Private artifacts: not available for a public repository's free tier in a way that survives forks and log access.
