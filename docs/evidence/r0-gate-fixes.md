# R0 gate fixes (builder S1, branch `r0-gate-fixes`)

Date: 2026-10-19. Base: `r0-foundations` at 6bb8116. Environment: Node 26.12.0, pnpm 12.14.0,
Rust 1.97.0 (CI pins 1.99.1), PostgreSQL 18.4, Chromium 153 from `@sparticuz/chromium`
(docs/ENVIRONMENT.md).

## 1. Phosphor icons (ADR-030)

Registry check, `npm view phosphor-svelte version peerDependencies license`:

```text
version = '3.1.1'
peerDependencies = { vite: '>=5', svelte: '^5.0.0 || ^5.0.0-next.96' }
license = 'MIT'
```

`pnpm --filter @rampsmith/ui add phosphor-svelte@3.1.1` added `"phosphor-svelte": "3.1.1"` to
`packages/ui/package.json` `dependencies` and updated `pnpm-lock.yaml` (pnpm also rewrote the
`§` escape in the package's `description` as `§`; the text is the same).

The five hand-written icons are replaced with `XIcon` (Dialog 16 px, Toaster 14 px),
`CaretRightIcon` (Disclosure, 12 px, same 90 degree rotation on `--rs-duration`),
`CaretDownIcon` (MenuButton) and `CaretUpDownIcon` / `CaretUpIcon` / `CaretDownIcon` (DataTable
sort), all `weight="bold"` and `aria-hidden="true"`. Controls keep `closeLabel` and
`dismissLabel` as their accessible names.

Proof, run in this worktree:

| Check | Result |
| --- | --- |
| `pnpm --filter @rampsmith/ui run typecheck` (svelte-check `--fail-on-warnings`) | `COMPLETED 472 FILES 0 ERRORS 0 WARNINGS` |
| `pnpm run typecheck` (whole workspace) | every package Done, apps/web `0 ERRORS 0 WARNINGS` |
| `pnpm run lint` (`eslint --max-warnings=0 .`) | no output, exit 0 |
| `pnpm run format:check` | `All matched files use Prettier code style!` |
| `pnpm --filter @rampsmith/web run sync && pnpm run knip` | no output, exit 0 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/tmp/chromium pnpm --filter @rampsmith/ui run test:browser` | `Test Files 4 passed (4)`, `Tests 33 passed (33)` (axe zero violations, keyboard, reduced motion) |
| `node packages/claims-lint/src/main.ts` | `14 files scanned, no banned claims` |
| `git grep -n '<svg' -- packages/ui/src apps/web/src` | no match (exit 1) |

Rendered DOM, read in Chromium by a throw-away probe test (not committed, because
`packages/ui/test` is outside this lane; the suggested permanent test is under "For the
architect"):

```text
dialog:     role=img aria-hidden=true fill=currentColor color=rgb(26, 26, 26)  16x16 button-name=Close
disclosure: role=img aria-hidden=true fill=currentColor color=rgb(31, 58, 95)  12x12 class=rs-disclosure-caret
disclosure-open transform: matrix(0, 1, -1, 0, 0, 0)        (rotate 90deg after the click)
menu:       role=img aria-hidden=true fill=currentColor color=rgb(31, 58, 95)  12x12 button-name=Actions
table:      two icons, role=img aria-hidden=true fill=currentColor, 12x12, in the Rule and Elements buttons
toast:      role=img aria-hidden=true fill=currentColor color=rgb(26, 26, 26)  14x14 button-name=Dismiss
```

The only other `<svg` in the repository is `apps/web/static/favicon.svg`, the brand mark, which
ADR-030 leaves as it is (`git grep -n '<svg' -- packages apps`).
