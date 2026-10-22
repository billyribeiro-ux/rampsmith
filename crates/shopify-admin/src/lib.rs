//! The Shopify Admin GraphQL client (PLAN §14, ADR-035, ADR-038).
//!
//! Phase 0 only reserves the crate, so that the workspace manifest and `Cargo.lock` carry its
//! dependencies before lane A (`r1-fixloop`) fills it in. Every Admin API call of Rampsmith
//! runs in `ctl` through this crate (ADR-035); the engine never links it.

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
