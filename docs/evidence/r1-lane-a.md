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

## Proposed LAUNCH.md section E rows

| Row | Live check that needs a founder input | Substitute test that passes now |
| --- | --- | --- |
| 1 | Real signed delivery from a development store reaches `/webhooks/shopify` and `app/uninstalled` ends the shop | `crates/api/tests/webhooks.rs`, `crates/ctl/tests/webhook.rs` (own HMAC, mock Admin API) |
| 2 | Admin GraphQL reads and writes against a development store on 2026-10 (cost, errors) | `crates/shopify-admin/tests/admin.rs` with fixtures shaped as documented |
| 3 | `shop/redact` and `customers/*` compliance webhooks from the Partner Dashboard test button | `shop_redact_deletes_the_shops_data_and_only_the_shops_data` |

Live tests are added with the later increments and skip with a notice naming the row.
