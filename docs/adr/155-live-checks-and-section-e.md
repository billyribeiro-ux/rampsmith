# ADR-155: Live checks for `rsctl doctor` and LAUNCH.md section E

- Status: Accepted
- Date: 2026-10-19

## Context

LAUNCH.md section E: a check that needs a founder input counts only when (1) a substitute test
passes in CI now, (2) the live test exists, "runs whenever the input is present, and otherwise
skips with a notice naming the input's row in C. It never passes silently", and (3) it has a row in
the section E table with the command that runs it live. CLAUDE.md adds: "A skipped test is not a
pass."

Rust's built-in test harness has no way to skip at run time: a test that returns early reports
"ok", and nextest counts it as a pass. `#[ignore]` is decided at compile time, so it cannot depend
on which variables are set. Section C inputs are absent in CI and in this sandbox, so the live
tests will skip in both until the founder adds them.

## Decision

1. **Substitute tests (condition 1)** run on every push, with no network beyond loopback:
   `tests/doctor/` (one module per probe, against a `wiremock` fake that answers with the
   vendor's documented or recorded responses and checks what the vendor checks: `SigV4`
   signatures for R2 and SES, an RS256 JWT for GitHub), `tests/sigv4.rs` (AWS vectors),
   `tests/redaction.rs`, `tests/keys_cli.rs` and `tests/live_plan.rs`. Counts are in
   `docs/evidence/ws-6-rsctl.md`.
2. **Live tests (condition 2)** are `tests/live.rs`, built with `libtest-mimic` (`harness = false`),
   which supports a per-trial ignored flag decided when the list is built:
   - There is one trial per check in `doctor::CHECKS`, named `c<row>_<check id>`, for example
     `c05_anthropic_models` (18 trials: rows 1 to 12 and row 15).
   - A trial runs whenever any variable of its own row that its check reads is set (`any`, not
     `all`: a half-filled row must run and fail as incomplete, not skip). A variable that a check
     reads from another row does not start it: the Partner API probe reads `SHOPIFY_API_KEY` only to
     compare the app's key, and the Railway workspace probe starts from `RAILWAY_API_TOKEN`, not
     `RAILWAY_TOKEN`. The one cross-row need is stated: the row 1 check exchanges the client
     credentials on development store A, so it is skipped, naming C row 3, until
     `SHOPIFY_DEV_STORE_DOMAIN` is set (the founder provides row 1 before row 3).
   - A started trial runs the real probe against the real vendor with the process environment, 30 s
     per request, and passes or fails. The one input the vendor documents no check for (the App
     Automation Token) has a trial that is always skipped by name, set or not, because a runner
     would count a quiet "ignored" return as a pass; `rsctl doctor` still reports it as not
     verifiable.
   - When a trial cannot run, it is flagged ignored, its name becomes
     `c05_anthropic_models_skipped_C_row_5` (the row of what is missing), and a line goes to
     standard error: `rsctl live: SKIP anthropic.models (C row 5: none of ANTHROPIC_API_KEY is
     set)`. A test runner that lists skipped tests (nextest prints `SKIP` and the name; `cargo test`
     prints `ignored`) therefore shows the row without any output capture.
   - Forcing a skipped trial to run (`--include-ignored`, `--run-ignored all`) fails it, saying it
     was forced to run without its input: a runner would otherwise count a quiet return as a pass.
   - Row 15 runs when `RSCTL_LIVE_PRODUCTION_SHOPIFY_API_KEY` and
     `RSCTL_LIVE_PRODUCTION_GITHUB_APP_ID` are set, with `SHOPIFY_API_KEY` and `GITHUB_APP_ID`
     holding the staging values; these two names are read only by the test binary.
   - The planning, skip rule and verdict mapping live in `tests/live_plan/plan.rs`, included by both
     `tests/live.rs` and `tests/live_plan.rs`, so CI proves the code the live binary runs: names,
     notices, the skip rule for every variable of every check, and the live path against fakes
     (a healthy service passes; a 401 fails without the secret in the message; an unreachable
     service fails). A verdict never hides a failure: a required input that is missing from a
     started row fails the trial.
3. **Live command (condition 3).** The primary live command is `rsctl doctor` (it is the product
   the check is about). The test-runner form is
   `cargo nextest run -p rampsmith-rsctl --test live --no-tests=pass` (or `cargo test -p
   rampsmith-rsctl --test live`). `--no-tests=pass` is needed only when no input is set at all:
   nextest 0.9.148 exits 4 ("no tests to run") when every trial is skipped and nothing else was
   selected. In a full-workspace run other tests run, so it is not needed there.
4. The Section E rows for this stream are in `docs/evidence/ws-6-rsctl.md`, for the integrator to
   copy into LAUNCH.md (not an edit this stream may make).

## Consequences

- A full `cargo nextest run --workspace` reports the 18 live trials as skipped, by name, in CI.
  Nothing in the pipeline reports them as passed.
- When the founder adds an input to the GitHub Actions secrets, CI does not see it unless the
  workflow passes it into the `rust` job's environment. That workflow is outside this stream; it
  is an integration note. Until then the founder runs `rsctl doctor` locally or on Railway.
- A live run makes real calls (mints a Shopify token, writes and deletes one R2 object per bucket).
  They are the least-privileged documented reads (ADR-152), and the object is removed.
- Trial names change with the environment (`..._skipped_C_row_5` becomes `c05_...`). Nothing
  selects a live trial by name in CI.

## Rejected alternatives

- A normal `#[test]` that returns early when the variable is unset: nextest reports a pass.
- `#[ignore]` on every live test and `--ignored` to run: it ignores the row and the variables, so
  a founder with half the inputs runs everything and reads failures for what is simply missing.
- Failing when an input is absent: the founder's accounts come last (CLAUDE.md), so absence is
  the normal state for now.
- Making the live tests part of `rsctl` itself: `rsctl doctor` is already that. The test binary
  exists so the repository's test tooling reports the skip.
