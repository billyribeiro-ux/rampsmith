//! `egress-guard` (PLAN §6, §18; ADR-025): the forward proxy every scanning browser uses.
//!
//! - Accepts `CONNECT host:443` tunnels and absolute-form `http://` requests on port 80.
//! - Requires a scan token as the proxy password, listing the hosts that page load may reach
//!   and a connection budget; anything else is refused.
//! - Resolves DNS itself, refuses the whole answer if any address is not public unicast, and
//!   connects to an address it checked, so DNS rebinding cannot slip a private address in.
//!   Redirects reach new hosts through new requests, each checked the same way.

mod policy;
mod proxy;
mod token;

use std::net::IpAddr;

pub use policy::AddressPolicy;
pub use proxy::{Proxy, ProxyConfig, Resolve, SystemResolver};
pub use token::{ScanToken, TokenKey};

/// Why egress refused a request. Shown to operators in logs and metrics, never to pages.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// No usable scan token.
    #[error("missing, invalid or expired scan token")]
    BadToken,
    /// The host is not on the token's list.
    #[error("host not allowed for this scan")]
    HostNotAllowed,
    /// Only 443 (tunnels) and 80 (plain HTTP) are proxied.
    #[error("port not allowed")]
    PortNotAllowed,
    /// The token's connection budget is spent.
    #[error("request budget exhausted")]
    BudgetExhausted,
    /// The name resolved to a non-public address.
    #[error("resolved to non-public address {0}")]
    NonPublicAddress(IpAddr),
    /// The name did not resolve.
    #[error("name did not resolve")]
    NoAddress,
    /// The request is not something a proxy accepts.
    #[error("malformed proxy request")]
    Malformed,
    /// The upstream could not be reached.
    #[error("upstream unreachable")]
    Unreachable,
    /// Configuration is unusable.
    #[error("{0}")]
    Misconfigured(&'static str),
}

impl Refusal {
    /// A stable label for metrics.
    #[must_use]
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::BadToken => "bad_token",
            Self::HostNotAllowed => "host_not_allowed",
            Self::PortNotAllowed => "port_not_allowed",
            Self::BudgetExhausted => "budget_exhausted",
            Self::NonPublicAddress(_) => "non_public_address",
            Self::NoAddress => "no_address",
            Self::Malformed => "malformed",
            Self::Unreachable => "unreachable",
            Self::Misconfigured(_) => "misconfigured",
        }
    }
}
