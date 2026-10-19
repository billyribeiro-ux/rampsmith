//! Substitute tests for every `rsctl doctor` probe: each runs against a local fake of its
//! vendor's service that answers with the vendor's documented (or recorded) responses, and
//! checks the same things the real service would check. LAUNCH.md section E, condition 1.

// Test code: PLAN §8 denies these lints outside tests only, and `pub` items in a test
// crate are shared between its modules, not an API.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    unreachable_pub
)]

mod support;

mod all_green;
mod anthropic;
mod cloudflare_dns;
mod dev_store;
mod github_app;
mod hostile;
mod master_keys;
mod otlp;
mod partner_api;
mod r2;
mod railway;
mod registry;
mod ses;
mod shopify_app;
mod staging;
mod stripe;
mod turnstile;
