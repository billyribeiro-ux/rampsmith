//! Plans, entitlements and Shopify App Pricing plan state for Rampsmith.
//!
//! Pure logic only (PLAN §8): nothing here opens a socket, reads a clock or touches the
//! database. Callers pass `now`, the stored state and whatever Shopify answered; the only
//! boundary to the outside is the injectable Partner API transport trait.
//!
//! - [`plan`] and [`entitlements()`]: the PLAN §20 catalog and the single function every
//!   limit comes from (ADR-132).
//! - [`usage`]: remaining alt-text drafts per monthly window (ADR-133).
//! - [`shopify`]: validated Shopify identifiers and the hosted plan page URL. A shop is the
//!   `shopify::ShopDomain` of `crates/shopify`; this crate has no copy of it.
//! - [`partner_api`]: the `activeSubscription` operation, its parser and transport trait.
//! - [`mod@reconcile`] and [`sweep`]: the plan-state machine and when to ask Shopify (ADR-131).
//! - [`stored`]: the plain-text row a shop's plan state is stored as (ADR-084).

pub mod entitlements;
pub mod money;
pub mod partner_api;
pub mod plan;
pub mod reconcile;
pub mod shopify;
pub mod stored;
pub mod sweep;
pub mod usage;

pub use self::shopify::{
    AppGid, AppHandle, IdError, PartnerOrganizationId, ShopGid, plan_selection_url,
};
pub use entitlements::{Entitlements, Feature, Gate, entitlements};
pub use money::{Currency, Money, MoneyError};
pub use plan::{BillingInterval, Plan, UnknownPlanHandle};
pub use reconcile::{Action, BillingEvent, BillingState, RedirectParam, reconcile};
pub use usage::{DraftQuota, DraftUsage, UsageError, remaining_alt_text_drafts};
