//! Which addresses the browser may reach: public unicast only (PLAN §18).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::IpNet;

use crate::Refusal;

/// Ranges that are not the public internet: loopback, private, link-local (cloud metadata),
/// CGNAT, documentation, benchmarking, multicast, reserved, and IPv6 transition prefixes
/// whose embedded IPv4 address cannot be checked.
const BLOCKED: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/128",
    "::1/128",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
];

/// The address check egress applies to every resolved address before connecting.
#[derive(Debug, Clone)]
pub struct AddressPolicy {
    blocked: Vec<IpNet>,
    exceptions: Vec<IpNet>,
}

impl Default for AddressPolicy {
    fn default() -> Self {
        Self {
            blocked: BLOCKED.iter().filter_map(|net| net.parse().ok()).collect(),
            exceptions: Vec::new(),
        }
    }
}

/// The IPv4 address an IPv6 address stands for, when it is IPv4-mapped (`::ffff:0:0/96`) or
/// NAT64 (`64:ff9b::/96`).
fn embedded_v4(addr: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = addr.to_ipv4_mapped() {
        return Some(v4);
    }
    // NAT64 well-known prefix: the last 32 bits are the IPv4 address.
    let octets = addr.octets();
    if octets.starts_with(&[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]) {
        let [.., w, x, y, z] = octets;
        return Some(Ipv4Addr::new(w, x, y, z));
    }
    None
}

impl AddressPolicy {
    /// This policy, also allowing `ranges` (test and staging networks). Every exception is
    /// logged at startup by the binary.
    #[must_use]
    pub fn allowing(mut self, ranges: &[IpNet]) -> Self {
        self.exceptions.extend_from_slice(ranges);
        self
    }

    /// Whether `addr` may be connected to.
    pub fn check(&self, addr: IpAddr) -> Result<(), Refusal> {
        if self.exceptions.iter().any(|net| net.contains(&addr)) {
            return Ok(());
        }
        let refused = |a: IpAddr| self.blocked.iter().any(|net| net.contains(&a));
        let embedded = match addr {
            IpAddr::V6(v6) => embedded_v4(v6).map(IpAddr::V4),
            IpAddr::V4(_) => None,
        };
        if refused(addr) || embedded.is_some_and(|v4| self.check(v4).is_err()) {
            return Err(Refusal::NonPublicAddress(addr));
        }
        Ok(())
    }

    /// Checks a whole DNS answer. A name that resolves to any refused address is refused
    /// entirely: mixing public and private answers is a rebinding signal.
    pub fn check_all(&self, addrs: &[IpAddr]) -> Result<(), Refusal> {
        if addrs.is_empty() {
            return Err(Refusal::NoAddress);
        }
        addrs.iter().try_for_each(|addr| self.check(*addr))
    }
}
