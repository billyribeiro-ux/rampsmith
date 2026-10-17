# WS-4 evidence: entitlements and Shopify App Pricing state

- Stream: WS-4, branch `ws/billing`, branched from `r0-foundations` at `e43f546`.
- Scope: `crates/billing` (package `rampsmith-billing`, lib `billing`); ADR-131 to ADR-134.
- Date: 2026-10-17. Environment: the Claude Code cloud sandbox (docs/ENVIRONMENT.md).
  Rust here is 1.97.0 (`RUSTUP_TOOLCHAIN=stable`) while `rust-toolchain.toml` pins 1.99.1;
  GitHub Actions on the pinned toolchain remains the authoritative gate. `mise` is absent, so
  the commands behind each `mise run` task ran directly. `CARGO_BUILD_JOBS=1`.

## Dependencies, read from the live registry

`curl -s https://crates.io/api/v1/crates/<name>` on 2026-10-17 (newest version, its license,
release date and MSRV):

```text
thiserror     max_stable 2.0.21  | newest 2.0.21  MIT OR Apache-2.0  2026-09-23 msrv 1.77
secrecy       max_stable 0.10.3  | newest 0.10.3  Apache-2.0 OR MIT  2024-10-09 msrv 1.60
serde         max_stable 1.0.229 | newest 1.0.229 MIT OR Apache-2.0  2026-07-18 msrv 1.56
serde_json    max_stable 1.0.154 | newest 1.0.154 MIT OR Apache-2.0  2026-10-11 msrv 1.71
time          max_stable 0.3.55  | newest 0.3.55  MIT OR Apache-2.0  2026-08-01 msrv 1.88.0
proptest      1.12.0  MIT OR Apache-2.0  2026-10-10  msrv 1.88  (new, dev-dependency only)
core_detect   max_stable 1.0.0   | newest 1.0.0   MIT/Apache-2.0     2021-05-09 msrv None
rand_xorshift max_stable 0.5.0   | newest 0.5.0   MIT OR Apache-2.0  2026-02-02 msrv 1.85
unarray       max_stable 0.1.4   | newest 0.1.4   MIT OR Apache-2.0  2022-11-30 msrv None
```

The first five are reused from `[workspace.dependencies]` at the versions already pinned.
`proptest` 1.12.0 depends on `rand ^0.10` (the workspace's 0.10.3), so no duplicate version;
with `default-features = false, features = ["std"]` its only new transitive crates are
`core_detect`, `rand_xorshift` and `unarray` (Cargo.lock diff of commit `03e6870`). ADR-134
records each one.

## Shopify documentation read (2026-10-17)

`curl` to shopify.dev is refused by this sandbox's egress proxy (`CONNECT tunnel failed,
response 403`), so the pages were read through the web-fetch tool. A direct fetch of
`https://shopify.dev/docs/apps/launch/billing/managed-pricing` timed out at the permission
prompt; the same page was then read at its current address.

| Page | Used for |
| --- | --- |
| https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing | Redirect parameters (`plan_handle`, `shop`, end of `charge_id` on 2026-04-28), no webhooks, `activeSubscription` as the check, plan page URL, USD only, 8 public plans, events |
| https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page | Store handle and app handle, `_top`, shop GID from the Admin API, five-minute caching of confirmed subscriptions only, never redirect a paying user on failure, `SHOPIFY_APP_GID` |
| https://shopify.dev/docs/api/partner/latest/active-subscription | Query, variables (`gid://shopify/App/1234`, `gid://shopify/Shop/5678`), example response, null and error cases, "Manage apps" |
| https://shopify.dev/docs/api/partner/latest/objects/ActiveSubscription | Field types and nullability (Partner API 2026-10) |
| https://shopify.dev/docs/api/partner/latest/enums/apppricinginterval | `EVERY_30_DAYS`, `ANNUAL` (2026-10) |
| https://shopify.dev/docs/api/partner/unstable/objects/PendingUpdate | `billingPeriod`, `items`, `legacySubscriptionId` |
| https://shopify.dev/docs/api/partner/latest/objects/FlatRatePrice | `active: Boolean!`, `amount: Decimal!`, `currency: Currency!` (2026-10) |
| https://shopify.dev/docs/api/partner/2026-10 and https://shopify.dev/docs/partner-api/getting-started | Endpoint, `X-Shopify-Access-Token`, 4 requests per second per client, throttled body, status codes, versions (2027-01 RC, 2026-10 latest) |
| https://shopify.dev/docs/apps/launch/built-for-shopify/requirements | Requirement 4.3.7 "Label and disable premium features" |
| https://shopify.dev/changelog/new-planhandle-field-managed-pricing.md | `AppRecurringPricing.planHandle` in the Admin API (2025-04), considered and rejected in ADR-131 |

Two Partner API reference pages showed "latest" as 2026-07 while three showed 2026-10 with
2027-01 as the release candidate; the 2026-10 overview page exists and documents the
endpoint, so 2026-10 is pinned.

## Gate (final run, commit after `095510b` plus the ADR and comment updates)

Commands from the worktree root, `CARGO_BUILD_JOBS=1 SQLX_OFFLINE=true RUSTUP_TOOLCHAIN=stable`:

```text
toolchain: rustc 1.97.0 (2d8144b78 2026-07-07)
$ cargo fmt --all --check
exit=0
$ cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.79s
exit=0
$ cargo test -p rampsmith-billing --locked
     Running unittests src/lib.rs
test result: ok. 39 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/monotonic.rs
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/partner_api.rs
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/plan_table.rs
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/reconcile.rs
test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/reconcile_props.rs
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/sweep.rs
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
exit=0
$ cargo deny --locked check
advisories ok, bans ok, licenses ok, sources ok
exit=0
$ cargo machete
cargo-machete didn't find any unused dependencies in this directory. Good job!
exit=0
GATE: PASS
```

105 tests, none ignored or skipped. The same gate passed before each of the five feature
commits (`03e6870`, `18e03e0`, `50438f6`, `d59e283`, `095510b`); the commit that added
`proptest` first ran Clippy without `--locked`, then with it.

Also run: `RUSTDOCFLAGS='-D warnings' cargo doc -p rampsmith-billing --no-deps` (clean) and
`node packages/claims-lint/src/main.ts` on Node 26.12.0: `claims-lint: 1 file scanned, no
banned claims`. claims-lint does not scan `crates/` or `docs/`; `git grep -i -E
'complian|lawsuit|guarantee|certif|100% accessible|protected from'` over `crates/billing` and
`docs/adr/13*.md` finds nothing.

## What each test file proves

| File | Proves |
| --- | --- |
| `tests/plan_table.rs` | Every PLAN §20 cell: prices (USD cents, monthly and yearly), cadence, sampling, alt-text drafts, image fixes, the exact feature set per plan, the gate for every plan × feature, minimum plans |
| `tests/monotonic.rs` | proptest, 512 cases each: a higher plan never has fewer features, a slower cadence, a smaller page budget on any generated store, fewer drafts, fewer image fixes or a lower price |
| `src/usage.rs` (unit) | Monthly windows on the anchor day; 31st clamped to short months; leap years (2028, 2029, 2032, 2100); year crossings; boundary instants; offsets; calendar fallback; out-of-range dates as errors; Free's lifetime 25; mid-window upgrade (8,500 left) and downgrade (0 until renewal); saturation |
| `src/money.rs`, `src/plan.rs`, `src/shopify.rs`, `src/entitlements.rs` (unit) | Exact decimal parsing (no floats, overflow, precision), currency codes, handles, intervals, shop domains, app handles, GIDs, the plan page URL, sampling floor, gates |
| `tests/partner_api.rs` | The operation document, endpoint and variables; the documented example and 9 other recorded fixtures; HTTP 401/429/5xx/4xx; documented GraphQL errors and throttling; malformed bodies; shop mismatch; the client over a fake transport; the token never in `Debug` or errors |
| `tests/reconcile.rs` | Every reconciliation transition: subscribe, upgrade, downgrade, scheduled change, scheduled cancellation ending in Free, withdrawn cancellation, unexpected cancellation, interval change, trial, failures, Free without a subscription, unknown handles, several plan items, unconfirmed and unrecognized redirects |
| `tests/reconcile_props.rs` | proptest, 2,048 cases each: a paid plan only ever comes from storage or the API (never from `plan_handle` alone); failures keep the stored plan and never redirect a shop with a plan; actions always match the state; only paid plans carry a usage anchor |
| `tests/sweep.rs` | Redirects always confirm; "no plan" never cached; 5-minute app-load freshness; 24-hour sweep; cycle and trial boundaries plus grace; exponential backoff to 6 hours |

## Live check still open

The Partner API answers are recorded fixtures copied from the documented shapes. The live
check (each plan selected on a development store, `plan_handle` and the item `handle` equal to
the plan handle, Free and cancellation behaving as ADR-131 models) needs LAUNCH.md section C
inputs 1 to 3 plus `SHOPIFY_APP_GID`; ADR-131 proposes its section E row.
