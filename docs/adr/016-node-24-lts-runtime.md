# ADR-016: Node.js 24.22.0 LTS for every Node service

- Status: Accepted
- Date: 2026-10-17
- Decided by: the founder (requirement); evidence gathered by the architect session
- Evidence: [`docs/evidence/node-24-lts-2026-10-17.md`](../evidence/node-24-lts-2026-10-17.md)

## Context

The founder requires Node.js to be the latest LTS release as of 17 October 2026. The plan had
pinned Node 26.x, which on that date is a Current release, not an LTS release.

| Line | Newest release on 17 Oct 2026 | Status | LTS from | Maintenance from | End of life |
| --- | --- | --- | --- | --- | --- |
| 24 "Krypton" | 24.22.0, tagged 14 Oct 2026 | Active LTS | 28 Oct 2025 | 20 Oct 2026 | 30 Apr 2028 |
| 26 | 26.12.0, tagged 14 Oct 2026 | Current | 28 Oct 2026 | 20 Oct 2027 | 30 Apr 2029 |

Sources: `schedule.json` in [nodejs/Release](https://github.com/nodejs/Release/blob/main/schedule.json);
the official tags in [nodejs/node](https://github.com/nodejs/node); and the release headings
"Version 24.22.0 'Krypton' (LTS)" in
[`CHANGELOG_V24.md` at v24.22.0](https://github.com/nodejs/node/blob/v24.22.0/doc/changelogs/CHANGELOG_V24.md)
and "Version 26.12.0 (Current)" in
[`CHANGELOG_V26.md` at v26.12.0](https://github.com/nodejs/node/blob/v26.12.0/doc/changelogs/CHANGELOG_V26.md).

Two further facts shape the images:

- Microsoft's Playwright 1.64.1 image installs Node from NodeSource's `node_24.x` channel
  ([Dockerfile.noble](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/Dockerfile.noble)),
  so its Node patch level is whatever 24.x was current when the image was built.
- Playwright 1.64.1 ships system-dependency lists for Debian 12 and Debian 13
  ([nativeDeps.ts](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/registry/nativeDeps.ts)),
  and the official `node` images publish `24.22.0-trixie-slim`
  ([library/node](https://github.com/docker-library/official-images/blob/master/library/node)).

## Decision

Node.js 24.22.0 is the runtime for `web`, `engine` and all repository tooling.

| Where | Pin |
| --- | --- |
| `.mise.toml` | `node = "24.22.0"` |
| Every `package.json` | `"engines": { "node": ">=24.22.0 <25" }` |
| `pnpm-workspace.yaml` | `engineStrict: true`. Without it, pnpm 12.14.0 installs even when the project's own `engines` excludes the running Node (evidence, section 5). |
| `web` and `engine` images | `FROM node:24.22.0-trixie-slim@sha256:<digest>`. Renovate refreshes the digest of that tag; it never raises the Node version. |
| Chromium for `engine` | `pnpm exec playwright install --with-deps chromium` during the image build |
| CI | mise installs Node from `.mise.toml`; each job logs `node --version` |
| Type definitions | `@types/node` 24.19.2, the newest 24.x typings (published 9 Oct 2026) |
| Cloud sessions | `npm i -g node@24.22.0` (`docs/ENVIRONMENT.md`), or the ADR-014 route with `node-linux-x64@24.22.0` (on npm since 15 Oct 2026) |

`mise run verify` fails when any of these pins disagrees with `.mise.toml`.

A later 24.x release is adopted only when it fixes a security issue, recorded as an amendment
to this ADR. Changing the major line, including to Node 26 after it becomes LTS on
28 October 2026, needs the founder's approval.

## Consequences

- Every npm package pinned in PLAN §7 accepts Node 24.22.0 in `engines.node`, and the
  `@types/node` peer ranges of Vite and Vitest accept 24.19.2 (evidence, section 4).
- Node 24 enters maintenance on 20 October 2026: critical bug fixes and security fixes only,
  until 30 April 2028.
- `web` and `engine` share one base image, so one digest update patches both.
- The `engine` image no longer inherits Microsoft's Playwright image. Its browser libraries come
  from Playwright's own Debian 13 dependency list, installed at build time.

## Rejected alternatives

- Node 26.12.0: a Current release on 17 October 2026.
- Microsoft's Playwright image for `engine`: its Node version floats within 24.x.
- `node:24.22.0-slim`: in the official images it is an alias of the Debian 12 (bookworm)
  variant. Naming `trixie-slim` makes the base system an explicit choice and uses the newer
  Debian release.
