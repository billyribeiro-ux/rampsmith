# Build status

Single source of truth for where the build stands and who is working. Every builder updates it.

Last updated: 2026-10-17 by the architect session (Node.js 24.22.0 requirement, ADR-016).

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

- **Node.js 24.22.0, a founder requirement (17 Oct 2026; ADR-016).** The R0 session started from
  `3eac5be`, whose plan pinned Node 26, and `r0-foundations` at `f8c712c` pins it: `.mise.toml`
  has `node = "26.12.0"`; the root `package.json` has `engines.node` `>=26.12.0 <27` and
  `@types/node` `26.6.5`; ADR-014 cites `node-linux-x64@26.12.0`. Before `r0-foundations`
  merges, merge `main` into it, then:
  1. Set every Node pin listed in ADR-016 to 24.22.0, including any CI workflow or Dockerfile
     added after `f8c712c`; regenerate `pnpm-lock.yaml`; switch ADR-014's sandbox binary to
     `node-linux-x64@24.22.0` (on npm since 2026-10-15).
  2. Add the `verify` check that fails when any Node pin disagrees with `.mise.toml`.
  3. Add ADR-016 to `docs/adr/README.md`. ADR numbers on `main` are fixed: if the branch has
     its own 016 by then, renumber the branch's.
  4. Record `node --version` from the CI log in `docs/evidence/`.

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
