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
  3. Merge `main` into the branch. The branch already uses ADR-016 to ADR-018, so give main's
     Node runtime ADR (`docs/adr/016-node-26-lts-runtime.md`) the next free number: rename the
     file, update every reference to it (PLAN §6 and §7, CLAUDE.md, `docs/ENVIRONMENT.md`, this
     file, the release-verifier, both Node evidence files) and add it to `docs/adr/README.md`.
  4. Record the CI log's `node --version` and `process.release.lts` in `docs/evidence/`.

  The release-verifier fails R0 until all four are done.

## Founder approvals

- 17 Oct 2026, pre-approved so builders proceed without asking: the PLAN §20 pricing as written;
  drafting legal text marked "attorney review required"; evidence-backed scope tweaks that keep
  every PLAN §5 exit criterion, each recorded in an ADR. Production deploys, spending, store
  submission, publishing legal text and destructive operations still need the founder.
- 17 Oct 2026, 20:20 UTC: "Get everything done and just leave my account to be added at the
  end." Builders never wait for an input in LAUNCH.md section C; every check that needs one is
  built now and tracked in LAUNCH.md section E for the end.

## Progress (scope and evidence rules: docs/LAUNCH.md)

- [ ] R0 Foundations — in progress on `r0-foundations`
- [ ] R1 Private beta
- [ ] R2 Public launch
- [ ] Launch extras (LAUNCH.md section B)
- [ ] Final evidence pack (LAUNCH.md section D)

## Waiting on founder

All founder inputs in LAUNCH.md section C are open, and by the founder's decision they come last:
builders do not wait for them. Each check that needs one goes into LAUNCH.md section E. Builders
keep this list to the inputs in the order the founder should add them at the end, each with the
command to run after it; `docs/FOUNDER_SETUP.md` has the steps.

## Founder notifications sent

- None yet.

## Scheduled tasks

- Continuation check: `trig_01NTAnum1gJ3USsxJn3qPbJq` ("Rampsmith continuation check"), every
  2 hours at minute 24 UTC. It starts the next builder when none is active, notifies the founder
  when only founder inputs remain, and disables itself once the product is launch-ready.
- Original R0 builder: `trig_01PkdkTUzdELnYTsZEQQeuVW` ("Rampsmith R0 build"), already fired and disabled.
