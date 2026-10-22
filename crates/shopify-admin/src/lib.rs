//! The Shopify Admin GraphQL client (PLAN §14, ADR-035, ADR-038, ADR-080 to ADR-082).
//!
//! Every Admin API call of Rampsmith runs in `ctl` through this crate (ADR-035); the engine
//! never links it and never holds a token.
//!
//! - [`AdminFactory`] and [`AdminClient`]: the transport, one POST per operation to
//!   `/admin/api/2026-10/graphql.json`, with Shopify's HTTP statuses and GraphQL `errors`
//!   mapped to [`AdminError`].
//! - [`Throttle`]: cost-based pacing from `extensions.cost.throttleStatus`, one bucket per shop
//!   shared by every job in the process.
//! - The read operations (`read`): shop, products with media, collections, pages, articles,
//!   menus and the live theme's identity, read only.
//! - The data-fix operations (`write`): read one field's live value and write one, for the four
//!   fields R1 fixes. A non-empty `userErrors` is an error, never a silent success.
//!
//! The operations are plain GraphQL documents with serde types rather than types generated
//! with `graphql_client`'s derive: the derive needs Shopify's introspection schema on disk,
//! which only a shop's token can fetch, so the documents are checked against recorded
//! responses instead (ADR-080). `graphql_client` supplies the request and response envelopes.

mod client;
mod error;
mod read;
mod throttle;
mod write;

pub use client::{AdminClient, AdminEndpoint, AdminFactory};
pub use error::{AdminError, UserError};
pub use read::{
    Article, Collection, Domain, ImageRef, Locale, MEDIA_PER_PRODUCT, MediaItem, Menu, MenuItem,
    PAGE_SIZE, Page, Product, ShopInfo, ShopPage, Theme,
};
pub use throttle::{MAX_QUERY_COST, QueryCost, Throttle, ThrottleStatus, Throttles};
pub use write::{Field, LiveValue, ResourceKind, Target, TargetError, same_value};

/// The Admin API version every operation is written and checked against (PLAN §7).
pub const API_VERSION: &str = "2026-10";

/// A GraphQL response as the Admin API sends it: `data`, `errors` and `extensions`.
pub type Response<T> = graphql_client::Response<T>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_version_is_the_pinned_one() {
        assert_eq!(API_VERSION, "2026-10");
    }

    #[test]
    fn a_response_with_errors_and_no_data_parses() {
        let parsed: Response<serde_json::Value> =
            serde_json::from_str(r#"{"data":null,"errors":[{"message":"Throttled"}]}"#)
                .expect("valid response");
        assert!(parsed.data.is_none());
        assert_eq!(parsed.errors.map(|e| e.len()), Some(1));
    }
}
