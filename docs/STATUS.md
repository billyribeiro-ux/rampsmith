# Build status

Single source of truth for where the build stands and who is working. Every builder updates it.

Last updated: 2026-10-17 by the architect session (Node.js 26 LTS decision, ADR-016).

## Active builder

- 2026-10-17 18:12 UTC: session started by the scheduled task "Rampsmith R0 build", working on
  branch `r0-foundations`. It started before this file existed, with R0-only instructions, so it
  will not update this file. The next builder reconciles its work against R0's exit criteria.

## Lock rule (apply before building)

A builder is active, and you must not build, if either is true:
1. `list_triggers` (include completed) shows a scheduled task named `Rampsmith R0 build`, or one
   whose name starts with `Rampsmith builder`, with `last_run.status` PENDING and fired less than
   10 hours ago, and it is not your own run.
2. Any branch other than `main` received a push in the last 90 minutes
   (`gh api repos/billyribeiro-ux/rampsmith/branches`, then each branch's latest commit date).

A PENDING run older than 10 hours whose branch has had no push for 3 hours is stale; ignore it.

## Required corrections (apply before the affected work merges)

- **Node.js 26 LTS, a founder decision (17 Oct 2026; ADR-016).** It replaces the 24.22.0
  requirement recorded earlier that day. `r0-foundations` already runs 26.12.0, and its CI passed
  on it (run 39060459727): keep it until the LTS release exists. Before R0 merges:
  1. Once the first 26.x release tagged LTS exists (due 2026-10-28), pin it everywhere ADR-016
     lists; regenerate `pnpm-lock.yaml`; point ADR-014's sandbox binary at
     `node-linux-x64@<that version>`; and replace the "first 26.x release tagged LTS" wording in
     ADR-016, PLAN §7 and §22, CLAUDE.md and `docs/ENVIRONMENT.md` with the version.
  2. Add the `verify` check that fails when any Node pin disagrees with `.mise.toml`.
  3. Merge `main` into the branch and add ADR-016 to `docs/adr/README.md`. ADR numbers on `main`
     are fixed: if the branch has its own 016 by then, renumber the branch's.
  4. Record the CI log's `node --version` and `process.release.lts` in `docs/evidence/`.

  The release-verifier fails R0 until all four are done.

## Progress (scope and evidence rules: docs/LAUNCH.md)

- [ ] R0 Foundations — in progress on `r0-foundations`
- [ ] R1 Private beta
- [ ] R2 Public launch
- [ ] Launch extras (LAUNCH.md section B)
- [ ] Final evidence pack (LAUNCH.md section D)

## Waiting on founder

All founder inputs in LAUNCH.md section C are open. Builders list here, in order, the specific
inputs and decisions that currently block a test or a gate, with the command to run after each.

## Founder notifications sent

- None yet.

## Scheduled tasks

- Continuation check: `trig_01NTAnum1gJ3USsxJn3qPbJq` ("Rampsmith continuation check"), every
  2 hours at minute 24 UTC. It starts the next builder when none is active, notifies the founder
  when only founder inputs remain, and disables itself once the product is launch-ready.
- Original R0 builder: `trig_01PkdkTUzdELnYTsZEQQeuVW` ("Rampsmith R0 build"), already fired and disabled.
