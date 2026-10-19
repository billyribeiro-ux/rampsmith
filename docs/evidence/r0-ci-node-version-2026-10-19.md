# Evidence: the Node.js version CI runs for R0 (required correction 3)

Recorded on 19 October 2026 for [ADR-029](../adr/029-node-26-lts-runtime.md) and the "Required
corrections" in `docs/STATUS.md` on `main`. Required corrections 1 (the `check:node-pins` gate)
and 2 (ADR-016 renumbered to 029) landed on `r0-foundations` in merge `c614314` from
`r0-corrections` (`d1bfeab`). This file records correction 3: the `node --version` that GitHub
Actions logged for the R0 head.

## CI run

- Run: [ci 39262741055](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39262741055),
  pull request #1, head `c3673f6`, conclusion `success` for all eight checks (`rust`, `node`,
  `contracts`, `e2e`, `images (api)`, `images (egress)`, `images (engine)`, `images (web)`).
- The "Node version (ADR-029)" step runs in the `node`, `e2e` and `contracts` jobs and fails the
  job when `node --version` differs from the `node` pin in `.mise.toml`.

## Log excerpt (job `contracts`, 118094364376)

```console
2026-10-19T13:45:06.6575725Z node                 26.12.0            ~/work/rampsmith/rampsmith/.mise.toml  26.12.0
2026-10-19T13:45:06.6576408Z pnpm                 12.14.0            ~/work/rampsmith/rampsmith/.mise.toml  12.14.0
2026-10-19T13:45:06.7420926Z ##[group]Run node --version
2026-10-19T13:45:06.7421250Z node --version
2026-10-19T13:45:06.7421582Z node -p 'process.release.lts ?? "not an LTS release"'
2026-10-19T13:45:06.7422566Z test "$(node --version)" = "v$(grep -Po '^node = "\K[^"]+' .mise.toml)"
2026-10-19T13:45:06.7623242Z v26.12.0
2026-10-19T13:45:06.7865403Z not an LTS release
```

The `node` job of the same run passed `check:node-pins`:

```console
2026-10-19T13:46:13.9269432Z [check:node-pins] $ node packages/node-pins/src/main.ts
2026-10-19T13:46:14.0280207Z node-pins: every Node.js pin agrees with .mise.toml (ADR-029)
```

## What this proves and what it does not

- CI runs Node 26.12.0, the version every pin names, and the gate fails on any disagreement.
- 26.12.0 is not an LTS release (`process.release.lts` is empty). By the founder's decision of
  17 Oct 2026, 22:37 UTC (ADR-029 amendment), releases may merge on it; nothing deploys until
  the first 26.x release tagged LTS (due 2026-10-28) is pinned everywhere ADR-029 lists and a
  CI log shows a non-empty `process.release.lts`. That follow-up stays open in `docs/STATUS.md`.
