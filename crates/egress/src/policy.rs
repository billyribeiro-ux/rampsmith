//! Which addresses the browser may reach: public unicast only (PLAN §18).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::IpNet;

use crate::Refusal;

/// IPv4 ranges that are not the public internet: loopback, private, link-local (cloud
/// metadata), CGNAT, documentation, benchmarking, multicast and reserved.
const BLOCKED_V4: &[&str] = &[
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
];

/// The only IPv6 block that holds public unicast addresses (RFC 4291, IANA's IPv6 address
/// space registry). Every other IPv6 address is refused, except the two forms that stand for
/// an IPv4 address, which are judged by that address (see [`embedded_v4`]). A deny list cannot
/// do this job: IPv4-compatible `::/96`, IPv4-translated `::ffff:0:0:0/96`, `SRv6` `5f00::/16`
/// and every range assigned later are outside it and refused without being named.
const GLOBAL_UNICAST_V6: &str = "2000::/3";

/// Special-purpose ranges inside [`GLOBAL_UNICAST_V6`]: IETF protocol assignments (Teredo,
/// benchmarking, ORCHID, ...), documentation (`2001:db8::/32` and `3fff::/20`, RFC 9637) and
/// 6to4, whose embedded IPv4 address cannot be checked.
const BLOCKED_V6: &[&str] = &["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"];

/// The address check egress applies to every resolved address before connecting.
#[derive(Debug, Clone)]
pub struct AddressPolicy {
    blocked: Vec<IpNet>,
    global_unicast_v6: Option<IpNet>,
    exceptions: Vec<IpNet>,
}

impl Default for AddressPolicy {
    fn default() -> Self {
        Self {
            blocked: BLOCKED_V4
                .iter()
                .chain(BLOCKED_V6)
                .filter_map(|net| net.parse().ok())
                .collect(),
            global_unicast_v6: GLOBAL_UNICAST_V6.parse().ok(),
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
        let public = match addr {
            IpAddr::V4(_) => !self.blocked.iter().any(|net| net.contains(&addr)),
            IpAddr::V6(v6) => match embedded_v4(v6) {
                // Judged by the IPv4 address it stands for, exceptions included.
                Some(v4) => self.check(IpAddr::V4(v4)).is_ok(),
                // Otherwise it must be global unicast and not special-purpose. If the block
                // failed to parse (it cannot: it is a constant), nothing is public.
                None => {
                    self.global_unicast_v6
                        .is_some_and(|block| block.contains(&addr))
                        && !self.blocked.iter().any(|net| net.contains(&addr))
                }
            },
        };
        if public {
            Ok(())
        } else {
            Err(Refusal::NonPublicAddress(addr))
        }
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
