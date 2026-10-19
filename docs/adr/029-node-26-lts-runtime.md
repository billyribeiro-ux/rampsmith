# ADR-029: Node.js 26 LTS for every Node service

- Status: Accepted
- Date: 2026-10-17
- Decided by: the founder. The first version of this ADR, earlier the same day, pinned 24.22.0,
  the newest LTS release at the time; the founder approved the move to the 26 LTS line after
  reviewing the support windows below.
- Evidence: [`node-26-lts-2026-10-17.md`](../evidence/node-26-lts-2026-10-17.md) and
  [`node-24-lts-2026-10-17.md`](../evidence/node-24-lts-2026-10-17.md)

## Context

| Line | Newest release on 17 Oct 2026 | Status | LTS from | Maintenance from | End of life |
| --- | --- | --- | --- | --- | --- |
| 24 "Krypton" | 24.22.0 | Active LTS | 28 Oct 2025 | 20 Oct 2026 | 30 Apr 2028 |
| 26 | 26.12.0 | Current | 28 Oct 2026 | 20 Oct 2027 | 30 Apr 2029 |

Source: `schedule.json` in [nodejs/Release](https://github.com/nodejs/Release/blob/main/schedule.json).

- **Launch timing.** The public App Store listing is targeted for 22 March 2027 (PLAN §26). On
  Node 24, Rampsmith would launch on a line that has had only critical and security fixes since
  20 October 2026 and that reaches end of life 13 months after launch. Node 26 is in Active LTS
  at launch and is supported until 30 April 2029.
- **The switch to LTS changes metadata only.** The notes of 24.11.0 and 22.11.0, the releases
  that moved those lines to LTS, both say: "Other than updating metadata, such as the
  `process.release` object, to reflect that the release is LTS, no further changes from Node.js
  [the previous Current release] are included." The code that becomes 26 LTS is the 26.x code
  available now.
- **The stack runs on 26.** Every npm package pinned in PLAN §7 accepts 26.12.0 in
  `engines.node`; the `@types/node` peer ranges of Vite and Vitest accept 26.6.5; Chromium and
  axe-core pass the seeded-page check on 26.12.0; and the R0 branch's CI passed on its 26.12.0
  pin ([run 39060459727](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39060459727)).
- **Images.** Microsoft's Playwright 1.64.1 image installs Node from a NodeSource channel at
  build time, so its patch level floats. The official `node` images publish
  `26.12.0-trixie-slim`, and Playwright 1.64.1 ships its system-dependency list for Debian 13.

## Decision

Node.js 26 LTS is the runtime for `web`, `engine` and all repository tooling.

- **The pin** is the first 26.x release tagged LTS (scheduled for 28 October 2026), then later
  26.x LTS releases. A release counts as LTS when its heading in `doc/changelogs/CHANGELOG_V26.md`
  at its tag ends in "(LTS)" and `node -p process.release.lts` prints a codename.
- **Until that release exists**, everything runs 26.12.0, and releases may merge to `main` on
  26.12.0 once their gates pass (founder decision, 17 Oct 2026, 22:37 UTC; see "Amendment" below).
  Nothing deploys until every pin below is the LTS release.

| Where | Pin |
| --- | --- |
| `.mise.toml` | `node = "<26.x LTS version>"` |
| Every `package.json` | `"engines": { "node": ">=<26.x LTS version> <27" }` |
| `pnpm-workspace.yaml` | `engineStrict: true`. Without it, pnpm 12.14.0 installs on a wrong Node without an error. |
| `web` image | `FROM node:<26.x LTS version>-trixie-slim@sha256:<digest>` |
| `engine` image | Node's binary copied from `node:<26.x LTS version>-trixie-slim@sha256:<digest>` onto Microsoft's Playwright image pinned by digest (ADR-028; amendment of 19 Oct 2026 below) |
| CI | mise installs Node from `.mise.toml`; each job logs `node --version` and `process.release.lts` |
| Type definitions | `@types/node` on 26.x (26.6.5 on 17 Oct 2026) |
| Cloud sessions | `npm i -g node@<version>` (`docs/ENVIRONMENT.md`), or the ADR-014 route with `node-linux-x64@<version>` |

`mise run verify` fails when any of these pins disagrees with `.mise.toml`. Later 26.x releases
arrive through Renovate under the full gate (PLAN §7 upgrade policy), and Renovate refreshes the
image digests the same way. Changing the major line needs the founder.

## Consequences

- One Node line from the R0 bootstrap through launch and about two years of production.
- R0 and later releases may merge on 26.12.0; the move to the LTS pin is a follow-up change
  under the full gate once the LTS release exists, and it must land before anything deploys.
- `web` and `engine` take Node from one official image, so one digest update moves both to the
  same Node build.
- The `engine` image takes Chromium and its libraries from Microsoft's Playwright image
  (ADR-028), and only Node's binary from the official image (amendment of 19 Oct 2026).

## Rejected alternatives

- Node 24.22.0: maintenance-only from 20 October 2026 and end of life on 30 April 2028,
  13 months after the planned launch.
- Releasing on 26.12.0: a Current release; the LTS release, due 28 October 2026, carries the
  same code.
- Microsoft's Playwright image for `engine` with its own Node: that Node version floats. Using
  the image with Node's binary copied from the pinned official image is accepted instead
  (amendment of 19 Oct 2026).
- A `-slim` tag without the Debian name: the image maintainers choose which Debian release it
  means (for 24.x it is Debian 12); `trixie-slim` makes the base an explicit choice.

## Amendment (17 Oct 2026, 22:37 UTC)

The founder lifted the merge hold so that work reaches `main` and is integrated and tested
sooner: "It can merge so we get things moving and tested", confirmed as "Yes, merge on 26.12.0".
Releases merge on 26.12.0 when every other gate passes. The pins must still agree: 26.12.0 in
`.mise.toml`, `engines.node`, both Node images and CI, with `@types/node` on 26.x, until the
LTS change replaces 26.12.0 everywhere at once. Deploying still waits for the LTS pin and,
for production, for the founder. "Releasing on 26.12.0" below is no longer rejected for merging;
it stays rejected for deploying.

## Amendment (18 Oct 2026): number and enforcement

- This record was written on `main` as ADR-016 while `r0-foundations` already used 016 for the
  pull-request gate mechanics, and the branch had meanwhile taken 028 for its service images. It
  was renumbered 029 when `main` merged into the R0 branch, and every reference moved with it.
- `mise run check:node-pins` (`packages/node-pins`, part of `mise run verify` and of CI's `node`
  job) enforces the table above: one exact 26.x pin in `.mise.toml`; `engines.node` equal to
  `>=<pin> <27` in every `package.json`; `@types/node` an exact 26.x version wherever declared;
  `engineStrict: true`; every `FROM node:` line on `node:<pin>-trixie-slim@sha256:<digest>`; no
  `actions/setup-node` or `node-version`; and every workflow job that installs Node logs
  `node --version` and `process.release.lts` and fails when the version differs from the pin.

## Amendment (19 Oct 2026): the engine image

The R0 branch built the `engine` image under ADR-028, not on `trixie-slim` with
`playwright install --with-deps` as the table above first said. The R0 release verifier found
the two records disagreeing, and the built image is the one CI proves
([run 39273064507](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39273064507),
`images (engine)`: the smoke test asserts `"node":"v26.12.0"` and scans a page with the
Chromium sandbox on). So this record follows ADR-028:

- `engine` runs on `mcr.microsoft.com/playwright:v1.64.1-noble` pinned by digest, with the base's
  own Node 24 removed and Node 26's binary copied from the same
  `node:<pin>-trixie-slim@sha256:<digest>` image that `web` uses. Node no longer floats: its
  version and build come from the official image named in the pin, which `check:node-pins`
  already checks on every `FROM node:` line.
- Chromium and its system libraries come from Microsoft's tested image instead of Playwright's
  Debian 13 dependency list, so the browser and its libraries are one build.
- The rejection of Microsoft's image above applies to its own NodeSource Node, which the image
  build deletes.
- The LTS follow-up changes the same `FROM node:` digest for both images; nothing else about the
  engine's Node changes.

