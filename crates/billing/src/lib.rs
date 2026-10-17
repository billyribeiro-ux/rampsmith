//! Plans, entitlements and Shopify App Pricing plan state for Rampsmith.
//!
//! Pure logic only (PLAN §8): nothing here opens a socket, reads a clock or touches the
//! database. Callers pass `now`, the stored state and whatever Shopify answered; the only
//! boundary to the outside is the injectable Partner API transport trait.

pub mod entitlements;
pub mod money;
pub mod plan;
pub mod shopify;
pub mod usage;

pub use entitlements::{Entitlements, Feature, Gate, entitlements};
pub use money::{Currency, Money, MoneyError};
pub use plan::{BillingInterval, Plan, UnknownPlanHandle};
pub use shopify::{
    AppGid, AppHandle, IdError, PartnerOrganizationId, ShopDomain, ShopGid, plan_selection_url,
};
pub use usage::{DraftQuota, DraftUsage, UsageError, remaining_alt_text_drafts};
