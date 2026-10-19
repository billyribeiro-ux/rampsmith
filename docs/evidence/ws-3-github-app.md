# WS-3 GitHub App library: evidence, 17 Oct 2026

Stream WS-3, branch `ws/github-app` from `e43f546`. Owned paths: `crates/github/`,
`infra/github-app-manifest.json`, `docs/adr/121-*` to `127-*`, this file. Local toolchain per
`docs/ENVIRONMENT.md`: rustc 1.97.0 (`RUSTUP_TOOLCHAIN=stable`; CI pins 1.99.1),
`CARGO_BUILD_JOBS=1`, cargo-deny 0.20.2, cargo-machete 0.9.2.

## Crate versions and licenses (crates.io, read 2026-10-17)

Read with `curl -s https://crates.io/api/v1/crates/<name>` (`max_stable_version`, that version's
`license`, `created_at`, `rust_version`). Every crate below was already in `Cargo.lock` at the
same version, so the declared version equals both the registry's latest and the locked one.

| Crate | Declared | Registry latest | License | Published | MSRV | How |
| --- | --- | --- | --- | --- | --- | --- |
| `aws-lc-rs` | 1.18.2 | 1.18.2 | ISC AND (Apache-2.0 OR ISC) | 2026-10-12 | 1.71.0 | direct, default features off (`aws-lc-sys`, `alloc`) |
| `base64` | 0.23.1 | 0.23.1 | MIT OR Apache-2.0 | 2026-08-04 | 1.71.0 | direct |
| `hmac` | 0.13.0 | 0.13.0 | MIT OR Apache-2.0 | 2026-03-29 | 1.85 | direct |
| `http` | 1.5.0 | 1.5.0 | MIT OR Apache-2.0 | 2026-07-29 | 1.57.0 | direct |
| `reqwest` | 0.13.5 | 0.13.5 | MIT OR Apache-2.0 | 2026-09-08 | 1.85.0 | direct, `default-features = false`, `rustls` |
| `sha2` | 0.11.1 | 0.11.1 | MIT OR Apache-2.0 | 2026-10-12 | 1.88 | direct, default features off |
| `url` | 2.5.8 | 2.5.8 | MIT OR Apache-2.0 | 2026-01-05 | 1.63 | direct |
| `proptest` | 1.12.0 | 1.12.0 | MIT OR Apache-2.0 | 2026-10-10 | 1.88 | dev |
| `secrecy` | 0.10.3 | 0.10.3 | Apache-2.0 OR MIT | 2024-10-09 | 1.60 | workspace |
| `serde` / `serde_json` | 1.0.229 / 1.0.154 | same | MIT OR Apache-2.0 | 2026-07-18 / 2026-10-11 | 1.56 / 1.71 | workspace |
| `time` | 0.3.55 | 0.3.55 | MIT OR Apache-2.0 | 2026-08-01 | 1.88.0 | workspace, + `formatting`, `parsing` |
| `tokio` | 1.53.3 | 1.53.3 | MIT | 2026-10-13 | 1.71 | workspace, + `sync` (tests: `macros`, `net`, `rt`, `time`) |
| `tracing` | 0.1.44 | 0.1.44 | MIT | 2025-12-18 | 1.65.0 | workspace |
| `opentelemetry` | 0.33.1 | 0.33.1 | Apache-2.0 | 2026-10-09 | 1.75.0 | workspace |
| `thiserror` | 2.0.21 | 2.0.21 | MIT OR Apache-2.0 | 2026-09-23 | 1.77 | workspace |
| `axum` | 0.8.9 | 0.8.9 | MIT | 2026-04-14 | 1.80 | workspace, dev (fake GitHub) |
| `tracing-subscriber` | 0.3.23 | 0.3.23 | MIT | 2026-03-13 | 1.65.0 | workspace, dev (span capture) |

Considered and not used (ADR-121): `jsonwebtoken` 11.1.0 (published 2026-09-16; deps include
optional `rsa` ^0.9.6, `pem` ^3, `simple_asn1` ^0.6, `aws-lc-rs` ^1.15.0, `signature` ^2.2.0)
and `octocrab` 0.54.5 (published 2026-10-17). The local RustSec database fetched by cargo-deny
lists RUSTSEC-2023-0071 (`rsa`) with `patched = []`.

`Cargo.lock` delta: `rampsmith-github` plus proptest's dev tree (`bit-set` 0.11.1, `bit-vec`
0.10.1, `borsh` 1.8.1, `borsh-derive` 1.8.1, `core_detect` 1.0.0, `fastrand` 2.5.0, `fnv` 1.0.7,
`linux-raw-sys` 0.12.1, `proc-macro-crate` 3.5.0, `proptest` 1.12.0, `quick-error` 1.2.3,
`rand_xorshift` 0.5.0, `rustix` 1.1.5, `rusty-fork` 0.3.1, `tempfile` 3.27.0, `toml_datetime`
1.1.2, `toml_edit` 0.25.17, `toml_parser` 1.1.5, `unarray` 0.1.4, `wait-timeout` 0.2.1, `winnow`
1.0.4), the same versions `origin/r0-foundations` (`b366419`) locks for `crates/crypto`. The first
build with `aws-lc-rs` and `sha2` default features added `untrusted` 0.7.1 and `const-oid`
0.10.2; turning those defaults off removed both.

## Documentation checked (docs.github.com and shopify.dev, 2026-10-17)

Fetched through the docs article API (`https://docs.github.com/api/article/body?pathname=…`);
plain `curl` to docs.github.com is blocked by the sandbox proxy (403 on CONNECT).

| Topic | Page | Facts used |
| --- | --- | --- |
| App JWT | /en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app | RS256; `iat` 60 s back (recommended); `exp` ≤ 10 min ahead; `iss` client ID (recommended) or app ID; `Authorization: Bearer` |
| Private keys | /en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps | PEM, PKCS#1 `RSAPrivateKey`; up to 25 keys; keys never expire |
| Installation token | /en/rest/apps/apps (create an installation access token) | `POST /app/installations/{installation_id}/access_tokens`; `repositories` / `repository_ids` ≤ 500; `permissions` keys `checks`, `contents`, `metadata`, `pull_requests`, `workflows` (write only); 201 `token`, `expires_at`; 401/403/404/422; one-hour expiry; variable-length tokens since 2026-04-27 |
| Installation object | /en/rest/apps/apps (get an installation) | `account` user (`login`, `id`, `type`) or enterprise (`id`, `name`, `slug`); `repository_selection` `all` or `selected` |
| API versions | /en/rest/about-the-rest-api/api-versions | `2026-03-10` (current) and `2022-11-28` (to 2028-03-10); default 2022-11-28; 410 for unsupported |
| Breaking changes | /en/rest/about-the-rest-api/breaking-changes | 2026-03-10: no Git database or check-run changes; pull requests lose `merge_commit_sha` |
| Rate limits | /en/rest/using-the-rest-api/rate-limits-for-the-rest-api | 403 or 429; `x-ratelimit-remaining: 0` + `x-ratelimit-reset`; `retry-after`; otherwise wait ≥ 1 min; 80 content-creating requests a minute |
| Blobs | /en/rest/git/blobs | create: `content`, `encoding` utf-8/base64, 201 `sha`; get: raw media type, ≤ 100 MB |
| Trees | /en/rest/git/trees | create: `base_tree`, `tree[]` (`path`, `mode`, `type`, `sha` or `content`), 201; get: `recursive`, `truncated`; symlink mode `120000` |
| Commits | /en/rest/git/commits | `message`, `tree`, `parents`; author defaults to the authenticated identity; 201 |
| Refs | /en/rest/git/refs | get `heads/<branch>` (404); create `refs/heads/…` (201, 422 exists); update `sha`, `force` default false |
| Pulls | /en/rest/pulls/pulls | list `head=owner:branch`, `base`, `state`; create `title`, `head`, `base`, `body` (201); update `title`, `body` (200); response `id`, `number`, `html_url`, `head.sha` |
| Check runs | /en/rest/checks/runs | Apps only; `conclusion` values incl. `success`, `failure`, `neutral`; required when completed; output `title`, `summary` |
| Permissions | /en/rest/authentication/permissions-required-for-github-apps | Git database writes need Contents write; check runs need Checks write |
| Webhook signatures | /en/webhooks/using-webhooks/validating-webhook-deliveries | `X-Hub-Signature-256: sha256=<hex>`; constant-time compare; test vector used in `githubs_documented_test_vector_verifies` |
| Webhook payloads | /en/webhooks/webhook-events-and-payloads | headers; 25 MB cap; installation events by default and not subscribable; `push` fields, 2048 commits; 22 `pull_request` actions |
| App manifest | /en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest | parameter list; `callback_urls` ≤ 10; flow and one-hour code exchange |
| Setup URL | /en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url | spoofable `installation_id`; verify with a user token |
| Registering an App | /en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app | OAuth during installation removes the Setup URL |
| Theme layout | shopify.dev /docs/storefronts/themes/architecture | eight directories; only `templates/customers` and `templates/metaobject` subdirectories; `layout/theme.liquid` required |
| GitHub integration | shopify.dev /docs/storefronts/themes/tools/github | only default-structure branches connect; other folders ignored; Shopify bot commits admin edits |

## Gate (from the worktree root, at the commit that adds this file)

```
$ RUSTUP_TOOLCHAIN=stable cargo fmt --all --check
(no output, exit 0)

$ RUSTUP_TOOLCHAIN=stable cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s)

$ RUSTUP_TOOLCHAIN=stable cargo test -p rampsmith-github --locked
     Running unittests src/lib.rs
test result: ok. 79 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/app_jwt.rs
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/client.rs
test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/manifest.rs
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/telemetry.rs
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/webhook.rs
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ RUSTUP_TOOLCHAIN=stable cargo deny --locked check
advisories ok, bans ok, licenses ok, sources ok

$ RUSTUP_TOOLCHAIN=stable cargo machete
cargo-machete didn't find any unused dependencies in this directory. Good job!

$ prettier --config .prettierrc.json --check infra/github-app-manifest.json
  (prettier 3.9.10, the binary from another worktree's node_modules; no install here)
Checking formatting...
All matched files use Prettier code style!
```

139 tests, none skipped or ignored. The whole crate suite passed four consecutive runs; the
client and telemetry binaries passed eight. No test calls github.com: the client tests run
against an Axum fake on `127.0.0.1` that verifies each App JWT's RS256 signature and claims
against a throwaway key generated at test start.

## Security properties and the tests that prove them

| Property | Tests |
| --- | --- |
| Private key never in `Debug`, `Display` or errors | `private_key_never_appears_in_debug_output`, `key_errors_never_contain_key_material`, `app::tests::non_rsa_der_is_rejected_without_echoing_it` |
| JWT claims per GitHub; signature verifies | `jwt_claims_follow_githubs_rules`, `jwt_signature_verifies_with_the_apps_public_key`, `get_app_authenticates_with_a_valid_jwt` |
| JWT and tokens never in `Debug`; tokens never serializable | `jwt_never_appears_in_debug_output`, `token::tests::token_debug_is_redacted`, `token::tests::installation_tokens_are_never_serializable` |
| Tokens narrowed, cached per scope, refreshed 5 min early, single-flight, evicted on 401 | `installation_token_request_is_narrowed_to_repository_and_permissions`, `installation_tokens_are_cached_per_scope`, `installation_tokens_refresh_five_minutes_before_expiry`, `concurrent_callers_share_one_token_refresh`, `a_rejected_token_is_dropped_and_the_next_call_mints_a_new_one`, `token::tests::a_token_can_never_request_workflows`, `fix_tokens_never_ask_for_more_than_the_manifest_grants` |
| Decode errors never echo response values | `error::tests::decode_errors_never_echo_response_values`, `malformed_token_responses_never_echo_the_token` |
| No token, JWT, key, path, repository name or content in spans | `spans_and_debug_output_never_contain_secrets_or_content`, `client::tests::op_templates_never_contain_concrete_values` |
| Webhook HMAC over raw body, constant time, verified before parsing | `githubs_documented_test_vector_verifies`, `signature_is_checked_before_the_body_is_parsed`, `prop_a_correct_signature_always_verifies`, `prop_any_change_to_the_body_fails`, `prop_any_change_to_the_signature_fails`, `prop_a_different_secret_fails`, `the_previous_secret_is_accepted_during_rotation` |
| Hostile webhook input never panics; errors leak nothing | `prop_random_bodies_and_headers_never_panic`, `prop_signed_random_payloads_never_panic`, `prop_signed_random_bytes_never_panic`, `webhook_errors_never_contain_the_body_secret_or_signature`, `oversized_payloads_are_refused_before_hashing` |
| Reads limited to theme directories | `env_files_are_rejected`, `key_files_are_rejected`, `dotfiles_and_dot_directories_are_rejected`, `traversal_absolute_backslash_and_percent_paths_are_rejected`, `paths_outside_theme_directories_are_rejected`, `unusual_characters_are_rejected`, `theme_tree_lists_only_regular_theme_files`, `symlinks_in_theme_directories_are_never_read` |
| Writes only to `rampsmith/`, never the connected branch; force only for re-derive | `writes_only_go_to_rampsmith_branches`, `the_connected_branch_is_never_writable`, `malformed_branch_names_are_rejected`, `a_batch_branch_equal_to_the_connected_branch_is_refused`, `a_pull_request_into_its_own_head_branch_is_refused_before_any_request`, `only_rederive_forces_a_ref_update`, `re_derive_force_pushes_and_fast_forward_refuses_a_rewrite` |
| Transport: no redirects, https only, bounded responses, typed errors | `redirects_are_not_followed`, `the_client_refuses_plain_http_to_a_remote_host`, `base_url_must_be_https_except_on_loopback`, `oversized_responses_are_refused`, `status_codes_map_to_typed_errors`, `primary_rate_limits_map_to_a_typed_error_with_the_reset_wait`, `secondary_rate_limits_honour_retry_after` |
| Untrusted text cannot inject trailers, HTML, links or mentions; no banned claims | `commit_trailer_cannot_be_injected_from_finding_or_summary`, `body_escapes_untrusted_finding_text`, `markdown::tests::code_span_neutralises_markdown_and_html`, `body_contains_no_banned_claims`, `plan_errors_never_contain_file_content` |

## Merge with `r0-foundations` and CI (19 October 2026, third stream wave)

Agent W3 brought the branch to merge-ready. Pull request #10 (draft, into `r0-foundations`,
"WS-3: GitHub App (do not merge; stream CI)").

**The merge.** `origin/r0-foundations` at `6bb8116` merged in by merge commit `7e156f6`; no
history was rewritten. One conflict, `Cargo.lock`: r0-foundations' lockfile was taken and cargo
added `rampsmith-github` (the proptest tree was already locked there). `base64`, `hmac`, `proptest`
and `url` now come from the workspace table (`base64.workspace = true` and so on), which gained
them on `r0-foundations` at the same versions as the table above. `aws-lc-rs`, `http`, `reqwest`
and `sha2` stay direct entries in `crates/github/Cargo.toml` because their feature sets differ
from the workspace entries (Cargo cannot switch a workspace dependency's default features off).

**Clippy 1.99.1 fixes.** CI pins Rust 1.99.1; the local gate ran 1.97.0. The first CI run of the
merge (run [39286328027](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39286328027),
head `7e156f6`) failed in the `rust` job on two lints that 1.99 added or tightened:

| Lint | Site | Fix (commit `5f9ac05`) |
| --- | --- | --- |
| `chunks_exact_to_as_chunks` | `decode_signature` in `crates/github/src/webhook.rs` | `hex.as_chunks::<2>()` on the 64-byte hex slice; the pairs leave no remainder, and the comment says so |
| `assert_is_empty` | `tests/client.rs` (2 sites), `tests/webhook.rs` (`repositories`, `repositories_added`) | the assertion carries a message that prints the value it expected empty |

No behaviour changed; the same 139 tests exercise both sites.

**CI on head `5f9ac05`.**

| Workflow | Run | Conclusion |
| --- | --- | --- |
| `ci.yml` | [39289693789](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39289693789) | success: rust (rustfmt, Clippy `-D warnings`, cargo-deny, cargo-machete, nextest on PostgreSQL 18.6), node, contracts, e2e, four image builds |

The count of 139 tests comes from the local run above (79 unit, 9 + 26 + 6 + 1 + 18 in the
integration binaries); the `Tests (cargo-nextest, PostgreSQL 18.6)` step concluded success, and its
count was not read from the CI log.

**Owed before merge: `security-auditor` at effort max.** This crate handles the App private key,
the App JWT, installation tokens, webhook signatures and the only code that writes to a customer's
repository. CLAUDE.md requires the `security-auditor` subagent at effort `max` for every change
to tokens, webhooks and egress-adjacent code, and no result for this branch is recorded (the
earlier run's result was never saved). W3 may not run it. The integrator runs it on `crates/github`
at the merge head and records the verdict in this file before the branch merges.

**Integration notes.**

1. `jsonwebtoken` is now in the workspace (`Cargo.toml`, 11.1.0, `aws_lc_rs` backend, no `rsa`
   crate in `Cargo.lock`). ADR-121 rejected `jsonwebtoken` for the GitHub App JWT because its
   `rsa` path carries RUSTSEC-2023-0071, and its consequences section already says nothing here
   changes if the main builder adds it for Shopify HS256 session tokens. `crates/github` keeps
   signing RS256 with `aws-lc-rs` directly; both crates share one `aws-lc-rs` 1.18.2 in the
   lockfile.
2. PLAN §7 corrections listed in ADR-121 (the `jsonwebtoken` and `octocrab` rows) are still
   to be made in PLAN.md, which this stream may not edit.
3. `docs/adr/README.md` has no rows for ADR-121 to ADR-127.
4. `infra/github-app-manifest.json` passes `prettier --check` with the repository config (run 19 October 2026).
