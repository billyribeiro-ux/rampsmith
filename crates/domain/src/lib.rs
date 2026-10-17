//! Pure domain types for Rampsmith.
//!
//! Nothing in this crate performs I/O. Everything here is deterministic and
//! testable without a network, a database or a runtime (PLAN §8).

pub mod impact;

pub use impact::{Impact, ParseImpactError};
