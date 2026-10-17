//! Pure domain types for Rampsmith.
//!
//! Nothing in this crate performs I/O. Everything here is deterministic and
//! testable without a network, a database or a runtime (PLAN §8).

pub mod enums;
pub mod ids;
pub mod impact;

pub use enums::{
    ActorKind, FindingStatus, FixChannel, FixKind, FixOrigin, FixStatus, PageState, Platform,
    ScanStatus, ScanTrigger, ShopStatus, TenantKind, UnknownVariant,
};
pub use ids::{FindingId, FixId, ScanId, ShopId, SiteId, TenantId, UserId};
pub use impact::{Impact, ParseImpactError};
