//! The address policy (PLAN §18): only public unicast addresses are reachable. Written first.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use egress::{AddressPolicy, Refusal};
use proptest::prelude::*;

fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

#[test]
fn public_addresses_are_allowed() {
    let policy = AddressPolicy::default();
    for addr in [
        "23.227.38.65", // Shopify
        "1.1.1.1",
        "8.8.8.8",
        "2606:4700::6810:84e5",
        "2620:127:f00f:e::",
    ] {
        assert!(policy.check(ip(addr)).is_ok(), "{addr}");
    }
}

#[test]
fn non_public_ipv4_ranges_are_refused() {
    let policy = AddressPolicy::default();
    for addr in [
        "0.0.0.0",
        "0.1.2.3",
        "10.0.0.1",
        "10.255.255.255",
        "100.64.0.1", // CGNAT
        "100.127.255.254",
        "127.0.0.1",
        "127.255.255.255",
        "169.254.169.254", // cloud metadata
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.8",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
    ] {
        assert!(
            matches!(policy.check(ip(addr)), Err(Refusal::NonPublicAddress(_))),
            "{addr}"
        );
    }
    // Neighbours of the ranges stay public.
    for addr in [
        "100.63.255.255",
        "100.128.0.0",
        "172.15.255.255",
        "172.32.0.0",
        "11.0.0.1",
    ] {
        assert!(policy.check(ip(addr)).is_ok(), "{addr}");
    }
}

#[test]
fn non_public_ipv6_ranges_are_refused() {
    let policy = AddressPolicy::default();
    for addr in [
        "::",
        "::1",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "fec0::1",
        "ff02::1",
        "2001:db8::1",
        "2001::1",          // Teredo
        "2002:c0a8:101::1", // 6to4
        "100::1",
        "64:ff9b:1::1",
    ] {
        assert!(
            matches!(policy.check(ip(addr)), Err(Refusal::NonPublicAddress(_))),
            "{addr}"
        );
    }
}

/// Audit L1: IPv6 is allowed only inside the global unicast block `2000::/3`, minus the
/// special-purpose ranges in it. Forms that used to slip through a deny list are refused.
#[test]
fn ipv6_outside_global_unicast_is_refused() {
    let policy = AddressPolicy::default();
    for addr in [
        "::7f00:1",         // IPv4-compatible 127.0.0.1 (::/96, deprecated)
        "::a9fe:a9fe",      // IPv4-compatible 169.254.169.254, the cloud metadata address
        "::808:808",        // IPv4-compatible 8.8.8.8: no form of ::/96 is public
        "::ffff:0:7f00:1",  // IPv4-translated 127.0.0.1 (::ffff:0:0:0/96, SIIT)
        "::ffff:0:808:808", // IPv4-translated 8.8.8.8
        "3fff::1",          // documentation, RFC 9637 (3fff::/20)
        "3fff:fff:ffff::1", // the last address of 3fff::/20
        "5f00::1",          // SRv6 SIDs, RFC 9602 (5f00::/16)
        "1fff:ffff::1",     // just below 2000::/3
        "4000::1",          // just above it
        "8000::1",
        "e000::1",
        "64:ff9b:1::808:808", // local-use NAT64, RFC 8215: not the well-known prefix
    ] {
        assert!(
            matches!(policy.check(ip(addr)), Err(Refusal::NonPublicAddress(_))),
            "{addr}"
        );
    }
    // The edges of the block, and the neighbours of 3fff::/20, stay reachable.
    for addr in [
        "2000::1",
        "2a00:1450:4001:81b::200e",
        "2606:4700:4700::1111",
        "3ffe:ffff::1",
        "3fff:1000::1", // first address after 3fff::/20
        "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ] {
        assert!(policy.check(ip(addr)).is_ok(), "{addr}");
    }
}

/// The exceptions still reach the ranges the policy refuses by default, for test and staging
/// networks, and only those.
#[test]
fn exceptions_open_ipv6_ranges_outside_global_unicast_too() {
    let policy = AddressPolicy::default().allowing(&["::1/128".parse().unwrap()]);
    assert!(policy.check(ip("::1")).is_ok());
    assert!(policy.check(ip("::7f00:1")).is_err());
}

#[test]
fn embedded_ipv4_addresses_are_checked_too() {
    let policy = AddressPolicy::default();
    // IPv4-mapped and NAT64 forms of private addresses are refused; of public ones, allowed.
    for addr in [
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::a00:1",
        "::ffff:10.1.2.3",
    ] {
        assert!(policy.check(ip(addr)).is_err(), "{addr}");
    }
    for addr in ["::ffff:8.8.8.8", "64:ff9b::808:808"] {
        assert!(policy.check(ip(addr)).is_ok(), "{addr}");
    }
}

#[test]
fn explicit_exceptions_open_only_their_range() {
    let policy = AddressPolicy::default().allowing(&["127.0.0.0/8".parse().unwrap()]);
    assert!(policy.check(ip("127.0.0.1")).is_ok());
    assert!(policy.check(ip("10.0.0.1")).is_err());
    assert!(policy.check(ip("::1")).is_err());
}

#[test]
fn a_resolution_with_any_refused_address_is_refused_whole() {
    let policy = AddressPolicy::default();
    let mixed = [ip("8.8.8.8"), ip("10.0.0.1")];
    assert!(policy.check_all(&mixed).is_err());
    assert!(policy.check_all(&[ip("8.8.8.8"), ip("1.1.1.1")]).is_ok());
    assert!(matches!(policy.check_all(&[]), Err(Refusal::NoAddress)));
}

proptest! {
    #[test]
    fn every_rfc1918_address_is_refused(a in 0u8..=255, b in 0u8..=255, c in 0u8..=255) {
        let policy = AddressPolicy::default();
        for addr in [
            Ipv4Addr::new(10, a, b, c),
            Ipv4Addr::new(172, 16 | (a & 0x0f), b, c),
            Ipv4Addr::new(192, 168, b, c),
            Ipv4Addr::new(127, a, b, c),
            Ipv4Addr::new(169, 254, b, c),
        ] {
            prop_assert!(policy.check(IpAddr::V4(addr)).is_err(), "{}", addr);
            prop_assert!(policy.check(IpAddr::V6(addr.to_ipv6_mapped())).is_err(), "{}", addr);
        }
    }

    #[test]
    fn every_unique_local_ipv6_address_is_refused(bits in any::<u128>()) {
        let ula = Ipv6Addr::from((bits & !(0x7f_u128 << 121)) | (0xfc_u128 << 120));
        prop_assert!(AddressPolicy::default().check(IpAddr::V6(ula)).is_err(), "{}", ula);
    }

    /// Whatever the bits, an IPv6 address outside 2000::/3 is refused unless it is one of the
    /// two forms that stand for an IPv4 address (mapped, or the well-known NAT64 prefix),
    /// which are judged by that address instead.
    #[test]
    fn every_ipv6_address_outside_global_unicast_is_refused(bits in any::<u128>()) {
        prop_assume!(bits >> 125 != 0b001);
        let mapped = bits >> 32 == 0xffff;
        let nat64 = bits >> 32 == 0x0064_ff9b_u128 << 64;
        prop_assume!(!mapped && !nat64);
        let addr = Ipv6Addr::from(bits);
        prop_assert!(AddressPolicy::default().check(IpAddr::V6(addr)).is_err(), "{}", addr);
    }

    /// The same, for the 3fff::/20 documentation block inside global unicast.
    #[test]
    fn every_documentation_ipv6_address_in_3fff_is_refused(low in 0u128..(1 << 108)) {
        let addr = Ipv6Addr::from((0x3fff_u128 << 112) | low);
        prop_assert!(AddressPolicy::default().check(IpAddr::V6(addr)).is_err(), "{}", addr);
    }
}
