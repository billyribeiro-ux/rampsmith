# ADR-028: Images for web, engine and egress

- Status: Accepted
- Date: 2026-10-17

## Context

PLAN §24 step 6 builds an image per deployable, with an SBOM and a fail on fixable high or
critical vulnerabilities; ADR-016 adds each image when its deployable exists. `web`, `engine`
and `egress` now exist beside `api`/`ctl`. PLAN §22 sets the bases: Node 26 slim for `web`,
Microsoft's Playwright image for 1.64.1 pinned by digest for `engine` (non-root, seccomp profile,
Chromium sandbox on), a Rust release binary for `egress`. The sandbox cannot reach `gcr.io` or
`mcr.microsoft.com` (ADR-014), so the `spikes` workflow resolved the digests on a GitHub runner
on 2026-10-17 ([run 39076633535](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39076633535),
job `digests`):

| Image | Index digest |
| --- | --- |
| `mcr.microsoft.com/playwright:v1.64.1-noble` | `sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf` |
| `gcr.io/distroless/cc-debian13:nonroot` | `sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2` |
| `node:26.12.0-trixie-slim` | `sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4` |

The Playwright image ships Node v24.21.0, `pwuser` (UID 1001), Chromium 1248, Firefox and
WebKit on Ubuntu 24.04.5; its Dockerfile at v1.64.1 installs Node from NodeSource with `git`,
`openssh-client` and `yarn`.

## Decision

1. **egress** builds on the pinned `rust:1.99.1-slim-trixie` and runs on distroless
   `cc-debian13:nonroot` (UID 65532): glibc, libgcc and CA certificates only.
2. **engine** installs its production dependencies with pnpm in the workspace layout and runs
   on the pinned Playwright image with Node 26.12.0's binary copied from the official Node
   image. The runtime stage applies Ubuntu security updates, removes the base's Node 24, yarn,
   git, ssh, Firefox and WebKit, makes `/ms-playwright` read-only and runs as `pwuser`.
   `main.ts` launches Chromium with `chromiumSandbox: true`. `infra/engine.seccomp.json` is
   Playwright's `utils/docker/seccomp_profile.json` at v1.64.1 (commit `cfe490d`): Docker's
   default profile plus the `clone`, `setns` and `unshare` calls the sandbox needs. The
   workspace layout matters: Node strips TypeScript only outside `node_modules`, and the
   workspace packages resolve to `/app/packages` through pnpm's links.
3. **web** builds with the full workspace install and runs `node build` on Node 26 slim as
   `node`, with production dependencies only, Debian security updates applied and npm removed.
   A new `/healthz` answers `{"status":"ok"}` without calling the api.
4. **api/ctl** stays on Debian slim: it links the system OpenSSL for `webauthn-rs-core`
   (ADR-024) and takes same-day Debian fixes through `apt-get upgrade` (ADR-020).
5. **CI.** The `images` job is a matrix over the four images; each runs its smoke test from
   `infra/smoke/`, then syft and grype as before. Smoke tests check the user, the refusal to
   start without configuration, and the service's first behaviour: `api` liveness and
   readiness, `egress` answering 407 to requests without a valid scan token, `engine`'s
   `self-check.ts` scanning a page with the sandbox on under the seccomp profile with no
   network, and `web`'s health check and security headers.

## Consequences

- A fixable vulnerability in a distroless or Playwright base fails the gate until its digest is
  bumped; Renovate (founder account) keeps the digests current.
- Whether Railway runs containers with a custom seccomp profile, which the sandbox needs, is
  checked at the first deploy (founder account). If it cannot, the fallback is the platform's
  own isolation with the sandbox off, decided then with evidence, not assumed now.
- `engine` is the largest image (Chromium and its libraries); the removals keep only what the
  scan uses.

## Rejected alternatives

- `pnpm deploy` for engine and web: it copies workspace packages into `node_modules`, where
  Node refuses to strip their TypeScript.
- Installing Chromium on a Node slim image with `playwright install --with-deps`: PLAN §22 pins
  Microsoft's image so the browser and its libraries come from one tested build.
