# WS-6 evidence: `rsctl`, the operator CLI (LAUNCH.md B5)

- Stream: W1, branch `ws/rsctl`, draft pull request #8 into `r0-foundations`
  (<https://github.com/billyribeiro-ux/rampsmith/pull/8>). Do not merge from this stream.
- Written: 2026-10-19. Toolchains: local Rust 1.97.0 (the pinned 1.99.1 cannot be installed in this
  sandbox); CI installs `rust-toolchain.toml` (1.99.x) and is the check for newer lints.
- ADRs: 151 to 156 in `docs/adr/` (151 CLI design and secret handling, 152 probes and vendor
  documentation, 153 master-key tools, 154 dependencies and `SigV4`, 155 live checks and section E,
  156 findings and plan corrections). 157 to 159 are unused.

## 1. What was built

`crates/rsctl` (package `rampsmith-rsctl`, library `rsctl`, binary `rsctl`, edition 2024, `unsafe`
forbidden, no `unwrap`/`expect`/`panic`/indexing outside tests, `anyhow` only in `main.rs`).

- `rsctl doctor`: 17 checks in production, 18 with `--environment staging`, one line each: PASS,
  FAIL with a reason, or SKIP naming the missing C row. `--json`, `--row N`, `--strict`,
  `--timeout`. Exit 0 / 1 (an input fails) / 2 (could not run). It reads only the 36 documented
  variables of LAUNCH.md section C rows 1 to 12 and prints no secret (ADR-151).

  | Check | C row | Live call (least-privileged documented read) |
  | --- | --- | --- |
  | `shopify.app` | 1 | client-credentials grant on dev store A, then `currentAppInstallation` (Admin API 2026-10) |
  | `shopify.partner-api` | 2 | Partner API `app(id)` and its `apiKey` against `SHOPIFY_API_KEY` |
  | `shopify.automation-token` | 2 | none: present is reported "not verifiable" |
  | `shopify.dev-store-a`, `-b` | 3 | `GET /password` (store exists); the password is not verifiable |
  | `github.app` | 4 | RS256 JWT to `GET /app`; id and client id compared |
  | `anthropic.models` | 5 | `GET /v1/models` and the three PLAN models |
  | `r2.evidence`, `r2.backups` | 6 | `PUT`, `GET`, `DELETE` one object per bucket (`SigV4`) |
  | `turnstile.siteverify` | 6 | siteverify with a made-up token expects `invalid-input-response` |
  | `ses.identity` | 7 | `GetAccount` and `GetEmailIdentity` (`SigV4`); no mail sent |
  | `railway.project-token` | 8 | `projectToken` query; environment name vs `--environment` |
  | `railway.workspace-token` | 8 (optional) | `project(id)` for the project the project token names |
  | `otlp.export` | 9 | empty `POST <endpoint>/v1/traces` (a valid request with no spans) |
  | `cloudflare.dns` | 10 (optional) | zones list, then `dns_records?per_page=1` |
  | `stripe.account` | 11 (optional) | `GET /v1/account`, plus key-shape and mode checks |
  | `master-keys.round-trip` | 12 | no network: `crates/crypto` parses the ring and every key seals and opens |
  | `staging.separate-apps` | 15 (staging only) | no network: staging ids differ from the production ids given as flags |

- `rsctl keys generate | rotate | drop | ids` (ADR-153), in the exact format `crates/crypto`
  reads; every ring is parsed back with `KeyRing::parse` before it is printed.
- Secrets: `Secret` (`Debug` `Secret([REDACTED])`, `Display` `[REDACTED]`), a `Redactor` over every
  printed line, vendor error codes only (never vendor text), HTTPS-only, no redirects, a 1 MiB body
  cap, fixed-text errors, a panic hook that prints the place only (ADR-151).
- `src/sigv4.rs`: AWS `SigV4` by hand for R2 and SES, checked against AWS's vectors (ADR-154).
- Live tests: `tests/live.rs` (`libtest-mimic`), 18 trials, ignored by name when the input is absent
  (ADR-155).

## 2. Registry checks (crates.io, 2026-10-19)

`cargo search` and `cargo info` against the live index:

| Crate | Version used | Latest on crates.io | rust-version | Note |
| --- | --- | --- | --- | --- |
| `clap` | 4.6.7 | 4.6.7 | 1.85 | new; default features off, `derive` on |
| `libtest-mimic` (dev) | 0.8.2 | 0.8.2 | 1.65 | new |
| `aws-lc-rs` (dev) | 1.18.2 | 1.18.2 | 1.71.0 | already in the tree |
| `jsonwebtoken` | 11.1.0 (workspace) | 11.1.0 | | `use_pem` added: `pem` 3.0.6, `simple_asn1` 0.6.4 |
| `reqwest` | 0.13.5 (workspace) | 0.13.5 | | |
| `time` | 0.3.55 (workspace) | 0.3.55 | | `parsing` feature added |
| `secrecy` | 0.10.3 (workspace) | 0.10.3 | | |
| `wiremock` (dev) | 0.6.5 (workspace) | 0.6.5 | | |

`aws-sdk-s3` 1.152.0 was measured, not adopted: 180 packages in its default tree, 58 not in
`Cargo.lock` (ADR-154). `Cargo.lock` gains 19 packages, all through `cargo`.

## 3. Tests

Substitute tests, all passing with no network beyond loopback
(`cargo nextest run -p rampsmith-rsctl --all-features --locked`): **221 passed, 18 skipped**.

| Binary | Tests | What it proves |
| --- | --- | --- |
| lib unit tests | 49 | `doctor` 17 (pure helpers), `keys` 11, `report` 6, `util` 5, `secret` 4, `vars` 4, `http` 2 |
| `tests/doctor` | 122 | one module per probe against a fake of its vendor: `shopify_app` 11, `partner_api` 9, `dev_store` 5, `github_app` 9, `anthropic` 8, `r2` 9, `turnstile` 9, `ses` 9, `railway` 11, `otlp` 8, `cloudflare_dns` 6, `stripe` 5, `master_keys` 5, `staging` 4; plus `all_green` 4 (the whole registry and the CLI against one healthy world), `hostile` 1 (a server that echoes the request in 6 statuses and 4 body shapes), `registry` 9 (drift against LAUNCH.md section C, every row 1 to 12 has a check, reads stay inside the declared set, a panicking probe fails alone) |
| `tests/keys_cli.rs` | 18 | generate, rotate, drop, ids through the library and the built binary; stdout/stderr split; 0600 file; never overwrites; exit codes; the panic hook re-exec |
| `tests/redaction.rs` | 9 | `Debug`, `Display`, every error type and re-encodings never carry a secret |
| `tests/sigv4.rs` | 9 | AWS's `aws-signing-test-suite` header-signing cases and the two Amazon S3 documentation examples |
| `tests/live_plan.rs` | 14 | the live trials' names, skip rule, verdicts and live path against fakes |
| `tests/live.rs` | 18 trials | ignored by name in CI (see section E) |

Each probe's fake verifies what the real service verifies: the SigV4 signature (R2, SES), the
RS256 JWT (GitHub), the documented headers and query parameters, and the recorded body shapes in
`tests/fixtures/` (one is a real 401 recorded from `api.anthropic.com` on 2026-10-19; the others are
copied from documented response shapes, with no real value in them). The recording env
(`RecordingEnv`) fails any probe that reads a variable outside its declared set.

## 4. Commands and output

Local gates on this branch head (Rust 1.97.0; CI runs 1.99.x):

```text
$ cargo fmt -p rampsmith-rsctl -- --check
(no output: formatted)

$ cargo clippy -p rampsmith-rsctl --all-targets --all-features --locked -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s)

$ cargo nextest run -p rampsmith-rsctl --all-features --locked
     Summary [   4.576s] 221 tests run: 221 passed, 18 skipped

$ cargo deny --locked check
advisories ok, bans ok, licenses ok, sources ok

$ cargo machete
cargo-machete didn't find any unused dependencies in this directory. Good job!

$ prettier --check crates/rsctl   (3.9.10, the repository .prettierrc.json options)
All matched files use Prettier code style!
```

`rsctl doctor` with nothing set (the CLI's default state in CI and in this sandbox): 17 lines, all
`SKIP  C<row> <check>  not set: <variables> (C row <row>)`, then `0 passed, 0 failed, 17 skipped`,
exit 0. With `--strict` the missing required inputs fail the run (exit 1).

`rsctl doctor --row 12` with a ring made by `rsctl keys` (throwaway keys, not printed here):

```text
rsctl doctor (production)
PASS  C12  master-keys.round-trip     2 key(s) parse; the active key `k2` seals and opens a probe value, and each of the 1 older key(s) does too
1 passed, 0 failed, 0 skipped
```

The live test binary, nothing set (`cargo test -p rampsmith-rsctl --test live`), 18 ignored by name:

```text
test c05_anthropic_models_skipped_C_row_5         ... ignored
test c06_r2_evidence_skipped_C_row_6              ... ignored
test c12_master_keys_round_trip_skipped_C_row_12  ... ignored
... (18 trials) ...
test result: ok. 0 passed; 0 failed; 18 ignored; 0 measured; 0 filtered out
```

Forced to run without their inputs (`--run-ignored all`), the trials fail (they never pass quietly):
`FAIL ... c01_shopify_app_skipped_C_row_1`, 18 of 18.

The live path against a real vendor, the one reachable from this sandbox: a deliberately wrong
`ANTHROPIC_API_KEY=sk-ant-bogus-LOCAL-TEST-KEY` run through `cargo test -p rampsmith-rsctl --test
live` reached `https://api.anthropic.com/v1/models` and failed as it should, without echoing the key:

```text
test c05_anthropic_models                         ... FAILED
C row 5: GET /v1/models failed: HTTP 401 authentication_error (the key was rejected)
test result: FAILED. 0 passed; 1 failed; 17 ignored; 0 measured; 0 filtered out
```

No other vendor host is reachable from this sandbox (only `api.anthropic.com` answers `curl`), so
every other probe's first real run is the founder's (section E).

## 5. CI

Pull request #8, workflow `ci`. History on this branch:

| Run | Head | Result | Why |
| --- | --- | --- | --- |
| [71](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39270881550) | `a86bec9` | failure | Clippy 1.99.0 `assert_is_empty` (3 test assertions); Prettier on 49 fixture JSON files |
| [72](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39272803371) | `9894530` | failure | the same two |
| 74 | `fa70920` | cancelled | superseded by the next push |
| [75](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39274603211) | `2e3cfb5` | **success** | all 8 jobs: `rust` (rustfmt, Clippy `-D warnings`, cargo-deny, cargo-machete, sqlx, nextest), `node` (ESLint, Prettier, tsc, knip, claims-lint, Vitest), `contracts`, `e2e`, 4 image builds |

Both failures were in files under `crates/rsctl`: the three assertions now compare against an empty
value, and the fixtures were reformatted with Prettier 3.9.10 and the repository options (contents
unchanged). Documentation-only commits after `2e3cfb5` re-run the same pipeline; the run on the
final head is linked in the pull request and in the hand-off.

No failure outside this stream's paths was seen.

## 6. Section E rows (for the integrator to add to LAUNCH.md)

Conditions (LAUNCH.md section E): (1) a substitute test passes now, (2) the live test exists and
skips with a notice naming the row, (3) the row has a live command. Every row's live trial is a
`c<row>_...` trial in `tests/live.rs`, filterable with `-E 'test(c05_)'` in nextest.

| Live check | Inputs (C) | Substitute test now | Live command |
| --- | --- | --- | --- |
| Shopify app credentials: client-credentials grant and `currentAppInstallation` on dev store A | 1, 3 | `cargo nextest run -p rampsmith-rsctl --test doctor shopify_app` (11 tests) | `rsctl doctor --row 1` |
| Partner API client: `app(id)` and its `apiKey`; App Automation Token present (not verifiable) | 2 (and 1) | `... --test doctor partner_api` (9) | `rsctl doctor --row 2` |
| Development stores A and B: the storefront password page answers | 3 | `... --test doctor dev_store` (5) | `rsctl doctor --row 3` |
| GitHub App: JWT reaches `GET /app`, id and client id match | 4 | `... --test doctor github_app` (9) | `rsctl doctor --row 4` |
| Anthropic key lists models and the three PLAN models | 5 | `... --test doctor anthropic` (8) | `rsctl doctor --row 5` |
| R2: object written, read back and deleted in both buckets; Turnstile secret accepted | 6 | `... --test doctor r2` (9), `turnstile` (9), `tests/sigv4.rs` (9) | `rsctl doctor --row 6` |
| SES: account out of the sandbox, sending identity verified (no mail sent). Test email delivered to the founder stays manual | 7 | `... --test doctor ses` (9) | `rsctl doctor --row 7` |
| Railway: project token works and names the right environment; workspace token (optional) reads the project | 8 | `... --test doctor railway` (11) | `rsctl doctor --row 8 --environment staging` (and `production`, with that environment's token) |
| Grafana Cloud OTLP endpoint and token accept an export | 9 | `... --test doctor otlp` (8) | `rsctl doctor --row 9` |
| Cloudflare DNS token reads its zone (optional) | 10 | `... --test doctor cloudflare_dns` (6) | `rsctl doctor --row 10` |
| Stripe test keys retrieve the account (R3 only) | 11 | `... --test doctor stripe` (5) | `rsctl doctor --row 11` |
| Master keys: ring parses and every key round-trips | 12 | `... --test doctor master_keys` (5), `tests/keys_cli.rs` (18) | `rsctl doctor --row 12` |
| Staging uses its own Shopify app and GitHub App | 15 (1, 4) | `... --test doctor staging` (4) | `rsctl doctor --environment staging --production-shopify-api-key <id> --production-github-app-id <id>` in the staging environment |
| All of the above in the test runner, skipped by name when an input is absent | 1 to 12, 15 | `cargo nextest run -p rampsmith-rsctl --test live_plan` (14) | `cargo nextest run -p rampsmith-rsctl --test live --no-tests=pass` |

The existing first row of the table (`rsctl doctor`, inputs 1 to 12, "each probe against a fake of
its service", `rsctl doctor`) is now true as written.

## 7. `rsctl keys generate` and `rsctl keys rotate`, for the master-key rotation runbook (W2)

Full text and rationale: ADR-153. The commands:

- `rsctl keys generate [--id ID] [--output FILE]` prints a new ring, `id:base64key`, once, to
  standard output (or to a new 0600 file with `--output`, never overwriting). The key is 32 bytes
  from the operating system's random source in unpadded standard base64 (43 characters), from
  `KeyRing::generate_master_key`; the id defaults to `k` and the UTC date, for example `k20261019`.
  A note on standard error says to store it as `RAMPSMITH_MASTER_KEYS` now. Run once for
  `production` and once for `staging`.
- `rsctl keys rotate [--id ID] [--stdin] [--output FILE]` reads the current ring from `--stdin`
  (first non-empty line) or from `RAMPSMITH_MASTER_KEYS` (never from an argument) and prints a new
  ring with a fresh key first and every old entry kept exactly as it was, so values sealed under
  an old key still open. A same-day second rotation gets `-2`, `-3`; an explicit duplicate `--id`
  is refused.
- `rsctl keys drop --id OLD [--id OLD2] [--stdin] [--output FILE]` removes old keys, refusing the
  active key and unknown ids. Only after nothing is sealed under them.
- `rsctl keys ids [--stdin]` lists ids, newest first (ids are not secret).
- Exit codes: 0 done, 1 refused (invalid ring, bad, duplicate or unknown id, dropping the active
  key), 2 could not run (no ring supplied, file exists, usage error).

Runbook order: (1) keep the current ring in the password manager; (2) `printf '%s'
"$RAMPSMITH_MASTER_KEYS" | rsctl keys rotate --stdin --output new-ring.txt`; (3) store the new ring,
set it as `RAMPSMITH_MASTER_KEYS` in staging then production, redeploy `api` and `ctl`, run
`rsctl doctor --row 12`; (4) re-wrap values sealed under old keys with `KeyRing::rewrap` (the
function exists in `crates/crypto`; **no job in the repository calls it yet**, so until one exists
the old keys stay in the ring); (5) `rsctl keys drop --stdin --id <old>` only when nothing is sealed
under it; (6) after a suspected leak, do 2 to 5 in that order and treat backups taken under the
leaked key as readable by whoever holds it.

Recorded run of the commands (throwaway keys; the rings are not printed):

```text
$ rsctl keys generate --id k1 --output ring-1.txt          exit 0, file mode 600
$ rsctl keys rotate --stdin --id k2 --output ring-2.txt < ring-1.txt
rsctl: new active key `k2`; older keys kept: k1. Set this ring as RAMPSMITH_MASTER_KEYS everywhere, ...
$ rsctl keys ids --stdin < ring-2.txt                      k2, k1
$ rsctl keys drop --stdin --id k2 < ring-2.txt             rsctl: `k2` is the active key; rotate to a new key first   (exit 1)
$ rsctl keys drop --stdin --id k1 --output ring-3.txt < ring-2.txt   exit 0; ids: k2
```

## 8. Integration notes (outside this stream's paths; nothing below was edited here)

For whoever merges. Each item has its reasoning in ADR-156.

1. **Variable names, row 1 (blocks deployment):** LAUNCH.md and FOUNDER_SETUP say `SHOPIFY_API_KEY`
   and `SHOPIFY_API_SECRET`; `crates/api`, `crates/ctl`, `apps/web` and `.env.example` read
   `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. `rsctl` follows LAUNCH.md. Decide one name and
   change the other side; for `rsctl` it is two strings in `crates/rsctl/src/vars.rs`.
2. **FOUNDER_SETUP row 12 draft says `TOKEN_MASTER_KEY`** (`ws/launch-docs`); LAUNCH.md and the code
   use `RAMPSMITH_MASTER_KEYS`.
3. **SES IAM policy** in FOUNDER_SETUP is send-only. Add `ses:GetAccount` and `ses:GetEmailIdentity`
   or the row 7 probe fails with a 403.
4. **FOUNDER_SETUP still says `rsctl doctor` is "not built yet"** and promises a test email, DNS and
   TLS checks, the active-subscription query and a storefront password check. The tool built here
   sends no mail, checks no hostnames, runs `app(id)` (not the billing query) and only checks that
   the password page answers (ADR-156 item 8).
5. **WS-10 adds `EMAIL_POSTAL_ADDRESS` and `EMAIL_TEST_RECIPIENT` to LAUNCH.md row 7** (ADR-191 on
   `ws/email`). The drift test (`tests/doctor/registry.rs`) will fail until `vars.rs` gets the
   matching `Var`s. That is intended.
6. **LAUNCH.md row 10 has no domain variable**; `doctor` lists up to three zone names for the
   founder to check instead of choosing the Rampsmith zone.
7. **`SHOPIFY_APP_GID` form**: the probe tries `gid://shopify/App/<id>` then `gid://partners/App/<id>`;
   the first live run tells which; amend ADR-131 (on `ws/billing`) accordingly.
8. **No automated check exists** for the App Automation Token, the storefront passwords, the GitHub
   webhook secret, Stripe's publishable key and webhook secret, or the Turnstile site key; they report
   SKIP "not verifiable" when set.
9. **Railway workspace token** is probed through the project the project token names (not a documented
   example; the input is optional).
10. **Key rewrap**: `KeyRing::rewrap` has no caller; a job that walks ciphertexts is needed before an
    old key can be dropped (ADR-153).
11. **Hoisting**: `clap`, `libtest-mimic` and `jsonwebtoken`'s `use_pem` feature are declared in
    `crates/rsctl/Cargo.toml` because root manifests are outside this stream; hoist them into
    `[workspace.dependencies]` if another crate adopts them.
12. **CI secrets**: the live trials run in CI only if the workflow passes the founder's inputs into the
    `rust` job's environment (they are skipped by name today). `.github/workflows/ci.yml` is outside
    this stream. Until then the founder runs `rsctl doctor` locally or on Railway.
13. **Clippy's `doc-valid-idents`** (`clippy.toml`) lacks `SigV4`; the crate writes it in backticks. Add it
    if other crates will mention it.
14. **PLAN §7**: annotate the `aws-sdk-s3` row (ADR-154).
15. **STATUS.md** is not touched by this stream; it should list `ws/rsctl` / PR #8 as the B5 stream.

## 9. Reviews owed

- **`security-auditor` at effort `max` is owed before this merges** (CLAUDE.md: auth, tokens,
  webhooks, `egress`, encryption, row-level security). Scope: `src/secret.rs`, `src/http.rs`,
  `src/sigv4.rs`, `src/keys.rs`, `src/app.rs` (panic hook, output paths), the redaction and
  hostile-echo tests, and the vendor request construction in `src/doctor/`. This stream did not run
  it (subagents are not available to it).
- `release-verifier` is the release-gate subagent for the merge to `r0-foundations`; not applicable
  to a draft stream pull request.

## 10. Known limits

- Only the Anthropic request shape has been seen against the real service (a 401 recorded on
  2026-10-19). Every other probe is built from the vendor documentation cited in ADR-152 and is
  exercised against fakes that check the same properties. The first live run of each probe is a
  section E row; a vendor that answers differently shows up as a FAIL with a status and a code.
- The hand-written `SigV4` signer is checked against AWS's published vectors and by fakes that
  recompute the signature; R2 and SES have not accepted it yet.
- Clippy 1.99 lints are checked by CI only; the local toolchain is 1.97.0.
