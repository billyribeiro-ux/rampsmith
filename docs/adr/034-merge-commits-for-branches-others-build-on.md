# ADR-034: Merge commits for branches that other branches build on

- Status: Accepted
- Date: 2026-10-19
- Amends: PLAN §24 "Repository rules"; LAUNCH.md section C row 14

## Context

PLAN §24 says `main` takes squash merges with linear history. That suits a pull request that
nobody else builds on. `r0-foundations` is not one: on 19 Oct 2026, eleven stream branches
(`ws/*`, draft PRs #2 to #14) and the builder team's lanes (`r1-hardening`, `r1-hardening-ts`,
draft PRs #15 and #16) all start from its commits, and the third-wave agents keep branching from
it (`ws/rsctl` starts at `c3673f6`).

A squash merge would put R0 on `main` as one new commit with none of those commits in its
history. Every later `git merge main` into a stream branch would then find a merge base from
before R0, and each file that R0 changed after the stream branched (for example
`crates/api/src/config.rs` and the lockfiles) would conflict against itself. A merge commit
keeps `r0-foundations`'s commits on `main`, so those merges see only the streams' own changes.

## Decision

1. A branch that other branches are built on (a release branch such as `r0-foundations`, or a
   stream branch other work depends on) merges to `main` with a merge commit titled in
   Conventional Commits, once its gate passes (CI green on the pinned toolchains and a
   `release-verifier` PASS, CLAUDE.md).
2. Every other pull request, including each `ws/` stream integrated on its own, keeps PLAN §24's
   squash merge.
3. `r0-foundations` stays after the merge, so the draft PRs into it keep running CI; retargeting
   them to `main` is the third-wave coordinator's call (STATUS.md).
4. Branch protection (LAUNCH.md section C row 14, the founder's settings) therefore must not
   require linear history; it requires the checks `rust`, `node` and `contracts` and allows both
   squash and merge commits.

## Consequences

- Stream integrations after R0 merge cleanly, and `git log --first-parent main` still reads as
  one entry per release or stream.
- `main`'s history is not linear. The changelog, generated from commit titles (PLAN §24), reads
  the first-parent titles.

## Rejected alternatives

- Squash R0 and rebase every stream branch on the result: rewrites history on branches other
  sessions own, which the build rules forbid.
- Squash R0 and resolve the self-conflicts at each stream's integration: eleven times the same
  conflict work, with room for mistakes in lockfiles and generated files.
