//! Time, injected so JWT claims and token expiry are testable without waiting.

use std::fmt;

use time::OffsetDateTime;

/// A source of the current UTC time.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Now, in UTC.
    fn now(&self) -> OffsetDateTime;
}

/// The system clock. Production servers keep it accurate with NTP, as GitHub asks.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}
