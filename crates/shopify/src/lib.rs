//! The Shopify protocol pieces Rampsmith needs before any Admin API call (PLAN §14, ADR-022):
//!
//! - [`ShopDomain`]: a validated `*.myshopify.com` host.
//! - [`SessionTokenVerifier`]: verifies App Bridge session (ID) tokens, HS256 with the client
//!   secret, with shopify.dev's checks and five seconds of clock leeway.
//! - [`TokenClient`]: token exchange for expiring offline tokens (`expiring=1`) and refresh.
//!
//! Nothing here stores or logs a token; callers seal them with `crates/crypto`.

mod domain;
mod session_token;
mod token;

pub use domain::{InvalidShopDomain, ShopDomain};
pub use session_token::{SessionToken, SessionTokenError, SessionTokenVerifier};
pub use token::{OfflineToken, TokenClient, TokenEndpoint, TokenError};

/// The Admin API version every call and webhook uses (PLAN §7).
pub const API_VERSION: &str = "2026-10";
