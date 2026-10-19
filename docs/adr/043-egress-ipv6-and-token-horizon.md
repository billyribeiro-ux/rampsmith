# ADR-043: Egress refuses IPv6 outside global unicast, scan tokens have a horizon, and spans carry no hosts

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-025 (egress guard and scan tokens)
- Source: R0 security audit findings L1, L14 and the egress part of L7
  (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

Three small gaps in the proxy that every scanning browser goes through.

1. **L1.** The IPv6 side of the address policy listed what to refuse (loopback, unique local,
   link local, multicast, documentation, and so on). A list of exclusions lets through every
   block nobody thought of, and IANA keeps reserving new ones.
2. **L14.** `TokenKey::verify` refused a token whose `exp` had passed, and accepted any `exp` in
   the future. The engine signs tokens that live two minutes (ADR-025); a token with an expiry
   a year ahead is not one it made, but anyone holding such a token (a leaked log line, a
   leaked signing secret used once) would keep it useful for as long as the secret lives.
3. **L7.** `egress.request` spans recorded `server.address`, the merchant's host. PLAN §19 says
   logs and spans carry ids, not domains.

## Decision

### 1. IPv6 is default-deny

An IPv6 address is allowed only if it is inside `2000::/3`, the block IANA allocates for global
unicast, and not inside the four special-purpose ranges within it: `2001::/23` (IETF protocol
assignments, including Teredo, ORCHID and benchmarking), `2001:db8::/32` and `3fff::/20`
(documentation, RFC 3849 and RFC 9637) and `2002::/16` (6to4, refused outright because the IPv4
address it embeds is not checked). Everything outside `2000::/3` is refused without being
listed: unspecified and loopback, IPv4-compatible (`::/96`), unique local, link local,
site local, multicast, SRv6 (`5f00::/16`), local-use NAT64 (`64:ff9b:1::/48`) and every block
assigned later.

Two kinds of address carry an IPv4 address inside them and are judged by that address, as
before: IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`, RFC 6052). The check runs
on the embedded IPv4 address with the full IPv4 policy, exceptions included, so
`::ffff:10.0.0.1` and `64:ff9b::7f00:1` are refused and `64:ff9b::808:808` (8.8.8.8) is not.

The IPv4 side is unchanged. The default policy still has no exceptions; tests and the loopback
exception in the harness use `AddressPolicy::allowing`.

### 2. Tokens have a horizon of five minutes

`TokenKey::verify` now refuses a token whose `exp` is more than `MAX_TOKEN_AHEAD_SECS` (300)
past the verifier's `now`, as it refuses an expired one: the same `BadToken` and the same 407.
The engine's two-minute lifetime fits with room for clock drift between the engine and egress.
The comparison saturates, so `exp = i64::MAX` cannot overflow the check.

The shared vectors in `crates/egress/testdata/tokens.json` (read by this crate's tests and by
`packages/engine/test/pure.test.ts`) were recomputed independently with a Python HMAC so that
`now` and the valid tokens' `exp` sit inside the horizon, and a vector with a distant `exp` was
added to the invalid set. The TypeScript signer keeps signing `now + 120`; it needs no change.

### 3. The host is not recorded

The `server.address` span field and its `record` call in the proxy's request handler are gone.
Spans carry the scan id from the token and the refusal reason, which is what an operator needs.
A test installs a capturing `tracing` subscriber, runs a tunnel, an HTTP request and each
refusal against hosts named `shop.test` and `other.test`, and asserts that no span or event
contains either name while the `egress.request` span and the scan id are present.

## Consequences

- A newly reserved IPv6 block is refused until `2000::/3` or the exclusion list is changed on
  purpose. A merchant on an IPv6-only host in a block outside `2000::/3` cannot be scanned; none
  exists today.
- A clock more than three minutes fast on the engine, or slow on egress, makes fresh tokens
  fail with 407. The failure is loud (a scan that cannot load pages) and the fix is NTP.
- Operators lose the host in the egress span. The metrics label stays the refusal reason, and
  the scan id joins the span to the scan row, which has the site.

## Plan correction

PLAN §18 (egress) and ADR-025 §3 say egress refuses "non-public addresses" without defining the
IPv6 rule: read them as "IPv6 outside `2000::/3`, plus the special-purpose blocks inside it",
and read ADR-025 §2 as "tokens expire at `exp`, and `exp` may not be more than five minutes
ahead".

## Rejected alternatives

- **Keep the exclusion list and add the missing ranges.** It finds today's gaps and not
  tomorrow's.
- **A horizon equal to the engine's 120 seconds.** Any clock skew would turn into refusals.
- **Hash the host in the span.** A hash of a domain is still a stable identifier of the merchant
  and is trivially reversible for guessable domains.
