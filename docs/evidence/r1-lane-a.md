# R1 lane A (fix loop, Rust): evidence

Run on 22 Oct 2026 with PostgreSQL 18, `RUSTUP_TOOLCHAIN=stable`, `SQLX_OFFLINE=true`.

## Increment 1: webhook listener, compliance topics, Admin client

| Gate | Command | Result |
| --- | --- | --- |
| Lints | `cargo clippy --workspace --all-targets -- -D warnings` | 0 warnings |
| Tests | `cargo test --workspace` | all suites ok, 0 failed |
| Webhook listener | `cargo test -p rampsmith-api --test webhooks` | 11 passed |
| Worker handler | `cargo test -p rampsmith-ctl --test webhook` | 8 passed |
| Admin client | `cargo test -p rampsmith-shopify-admin` | 13 unit, 14 integration passed |
| Isolation | `cargo test -p rampsmith-db --test tenancy` | webhook, shop-info, redact and cancel paths added, 0 cross-tenant access |

What the tests prove: unsigned, wrongly signed, oversized and header/body-mismatched deliveries are
refused before any database access; a delivery is stored once per id and once per body digest in
24 hours; a real uninstall ends the shop, deletes tokens and cancels queued work; a replay against a
working token changes nothing; `shop/redact` empties one tenant and leaves another whole, twice.

## Increment 2: Admin client and store reads

`cargo test -p rampsmith-shopify-admin` (16 integration tests incl. owner lookups) and
`cargo test -p rampsmith-ctl --test read_store` (5): every kind is read, stored as `scan_inputs`
batches, one `audit.data@1` per batch and one `scan.plan@1` per scan, retried without duplicates.
A revoked grant fails the scan for good; an outage retries and stores nothing. The `shop` input
carries the plan's `sampling` (Free `home_plus` 5; Starter 3, Growth 10, Pro 25 with every variant)
and Shopify's shop id is recorded for the Partner API.

## Increment 3: data fixes and undo

`cargo test -p rampsmith-ctl --test data_fix` (7): apply writes only when the live value still
equals the snapshot's `before`; a changed value fails the fix with `conflict_value_changed` and
writes nothing; a fix without an approval record is refused; apply creates a `verify` scan and queues
`verify.scan@1`; undo writes `before` only while the live value equals `after`, refuses otherwise
(`conflict_live_value_changed`) and reopens the findings. Isolation: `assert_data_fixes_isolate`.

## Increment 4: the embedded app's operations, plan state, Partner API fairness

| Gate | Command | Result |
| --- | --- | --- |
| Lints | `cargo clippy --workspace --all-targets --exclude rampsmith-egress -- -D warnings` | 0 warnings |
| Format | `cargo fmt --all --check`, `prettier --check` on `api.json` and `api.ts` | clean |
| Operations | `cargo test -p rampsmith-api --test app` | 23 passed |
| Fairness | `cargo test -p rampsmith-api --lib plan` | pacing (3 a second, 6 of 12 queued callers served, the rest refused), single flight |
| Config | `cargo test -p rampsmith-api --lib config` | partner variables all-or-none, token never in `Debug` |
| Isolation | `cargo test -p rampsmith-db --test tenancy` | 23 passed incl. `the_embedded_apps_queries_*` (with and without RLS) |
| Stored plan | `cargo test -p rampsmith-billing --lib stored` | every standing round-trips; an untrusted paid row is Unknown |
| Workspace | `cargo test --workspace --exclude rampsmith-egress` | 0 failed |
| Contracts | `gen-openapi` then `generate-api.ts` | `api.json` and `api.ts` regenerated, `tsc` clean |

What `tests/app.rs` proves: counts exclude best practices and verification scans; a second scan is
a 409 and a stale one does not block; another shop's scan, finding, fix and evidence are 404 and
unchanged by edit, reject and undo; approve records the staff `sub`, queues exactly one apply job
and one audit entry, and a second approval queues nothing; Free refuses the 26th image with 403; an
undo queues one revert and a second is a 409; the storefront password is sealed under the documented
context, opens with the key ring, is absent from every response and audit entry, and is cleared by
`null`; with no keys saving it is 503 and the whole update is refused; a Partner answer sets the
plan and is not asked again within 5 minutes; `plan_handle=pro` grants nothing and starts no call; a
failed call keeps the stored plan and backs off; no call is made before the shop id is recorded.

Not verified here: the egress crate's integration test needs outbound network and fails in this
sandbox; it is unrelated to this lane.

## Proposed LAUNCH.md section E rows

| Row | Live check that needs a founder input | Substitute test that passes now |
| --- | --- | --- |
| 1 | Real signed delivery from a development store reaches `/webhooks/shopify` and `app/uninstalled` ends the shop | `crates/api/tests/webhooks.rs`, `crates/ctl/tests/webhook.rs` (own HMAC, mock Admin API) |
| 2 | Admin GraphQL reads and writes against a development store on 2026-10 (cost, errors) | `crates/shopify-admin/tests/admin.rs` with fixtures shaped as documented |
| 3 | `shop/redact` and `customers/*` compliance webhooks from the Partner Dashboard test button | `shop_redact_deletes_the_shops_data_and_only_the_shops_data` |

| 4 | The real Partner API answers the active-subscription query for a development store, and the plan it reports sets the app's entitlements | `crates/api/tests/app.rs` (mock Partner API in the documented shapes); `crates/api/tests/live.rs` skips naming the row until `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_APP_GID` and `RAMPSMITH_LIVE_SHOP_GID` are set |

Live tests: `crates/shopify-admin/tests/live.rs` (row 2) and `crates/api/tests/live.rs` (row 4) skip
with a notice naming the row and the variables they need, and run for real when those are set.
