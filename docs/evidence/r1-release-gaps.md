# R1 release gaps: strict image smoke tests on main

Failing run: [39873911672](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39873911672)
on main 44ca4a7, `verify api` (ctl), `verify egress`, `verify engine`.

| Failure | Cause | Fix | Decision |
| --- | --- | --- | --- |
| ctl: no 200 from `/healthz` on 8080 | ctl served no HTTP | `crates/ctl/src/health.rs`, bound first | ADR-264 |
| egress: no 200 from `/healthz` on 8888 | every request was a proxy request | origin-form `GET /healthz` answered, never proxied | ADR-264 |
| engine: exited without a custom seccomp profile | Chromium's sandbox refused by the host; no health route | sandbox first, `--no-sandbox` only on a refusal, logged; health route | ADR-265, ADR-264 |

## Commands run locally

- `cargo test -p rampsmith-egress` (11 proxy tests, including
  `the_health_check_answers_for_the_process_and_is_never_proxied`), `cargo test -p rampsmith-ctl --lib`
  (health and config tests), `cargo clippy -p rampsmith-ctl -p rampsmith-egress --all-targets -- -D warnings`.
- `npx vitest run test/browser.test.ts test/health.test.ts` in `packages/engine` (36 tests),
  `tsc`, ESLint `--max-warnings=0`, `knip --workspace packages/engine`.
- `python -m unittest discover -s infra/railway/tests` (88 tests), `shellcheck` on
  `image_smoke.sh` and `infra/smoke/egress.sh`.

## CI

Pull request [#31](https://github.com/billyribeiro-ux/rampsmith/pull/31), head 2787b61:
`ci` [39878048418](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39878048418) and
`release` [39878048592](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39878048592)
green, with no "integration gap" annotation on any `image <service> (dry run)` job. The engine job
no longer has a gap path: an engine that exits, logs no sandbox mode, or runs unsandboxed without
the refusal warning fails the job, on pull requests as on `main`.

The strict run on `main` after the merge is recorded below.
