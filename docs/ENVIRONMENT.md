# Build environment: verified facts

Verified in the Claude Code cloud environment on 17 October 2026 by running each command.
GitHub Actions is the authoritative gate: it runs the pinned toolchains from PLAN §7.
The cloud environment is for fast local iteration, with the workarounds below.

| Need | PLAN pin | Available here | How to get it here (verified) |
| --- | --- | --- | --- |
| Node.js | 26 LTS (ADR-029); 26.12.0 until the first 26.x LTS release | 22.22.0 preinstalled; nodejs.org is blocked | `npm i -g node@26.12.0` installs it through the npm registry into `/home/claude/.npm-global/bin`, which is first on `PATH`; use the LTS version once it is on npm. To replace an installed version, first delete `/home/claude/.npm-global/lib/node_modules/node` and `/home/claude/.npm-global/bin/node`, or npm fails with `EEXIST`. Verified: `node --version` prints `v26.12.0`; `node -p process.release.lts` prints `undefined` until the LTS release |
| pnpm | 12.14.0 | 10.28.0 preinstalled | `npm i -g pnpm@12.14.0` |
| mise | current | Not installed; mise.run and GitHub release assets are blocked | Keep `.mise.toml` for founders and CI; locally use the npm-installed Node and pnpm |
| Rust | 1.99.1 | 1.97.0 only; static.rust-lang.org is blocked | Keep `rust-toolchain.toml` at 1.99.1 for CI; run local cargo with `RUSTUP_TOOLCHAIN=1.97.0`. Set `rust-version = "1.97"` so code builds on both. axum 0.8.9, tokio 1.53.3 and sqlx 0.9.0 build on 1.97.0 here. |
| Crates | — | crates.io works | `cargo fetch` and `cargo build` succeed |
| npm packages | — | registry.npmjs.org works | — |
| PostgreSQL | 18 | System PostgreSQL 16.15; no PostgreSQL 18 package via apt | `npm i @embedded-postgres/linux-x64@18.4.0-beta.17` provides PostgreSQL 18.4 binaries (`initdb`, `pg_ctl`, `postgres`). Run them as a non-root user; connect with the system `psql`. Row-level security verified. |
| Docker | — | Daemon starts with `dockerd &`, but Docker Hub is blocked | `testcontainers` works only in GitHub Actions. Local integration tests use the embedded PostgreSQL 18 above. |
| Chromium for Playwright | Playwright's bundled Chromium | Playwright's browser CDN is blocked | `npm i playwright-core@1.64.1 @sparticuz/chromium@153.0.0`, then launch with `executablePath: await chromium.executablePath()` and `args: chromium.args`. Verified on Node 26.12.0 and 24.22.0: Chromium 153.0.8010.0 launched and axe-core 4.14.0 reported exactly the 6 seeded violations (`docs/evidence/node-26-lts-2026-10-17.md`). CI uses `playwright install --with-deps chromium`. |
| PHP | 7.4 to 8.5 matrix | PHP 8.3.6 | Local WordPress plugin checks on 8.3; the matrix runs in CI |
| GitHub | — | `git` push and fetch work through the proxy; `gh api` reads work; `GH_TOKEN` is not a valid login | Read CI results with `gh api repos/billyribeiro-ux/rampsmith/actions/runs` |
| Hardware | — | 2 vCPUs, 7 GB RAM | Keep browser concurrency at 2 locally |

Facts that change the plan's local-test wording:
- PLAN §23 lists `testcontainers` for the data layer. Locally that becomes the embedded PostgreSQL 18;
  CI keeps `testcontainers` or a `postgres:18` service container.
- Any blocked download is recorded in an ADR the first time a session works around it.

The repository is public, so GitHub Actions minutes on standard runners cost nothing.
