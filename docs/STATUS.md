# Build status

Single source of truth for where the build stands and who is working. Every builder updates it.

Last updated: 2026-10-17 by the architect session (initial version).

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
