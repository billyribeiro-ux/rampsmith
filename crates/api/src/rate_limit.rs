//! Rate limits for the unauthenticated passkey `start` endpoints (audit M6, ADR-042).
//!
//! `register/start` and `sign-in/start` take no credentials and each inserts a ceremony row,
//! so anyone who can reach them can fill the table and, through `register/start`, probe which
//! emails have accounts. Two limits apply, both before any parsing or database work:
//!
//! - **Per client**: a small burst and a slow refill for each address, so one source cannot
//!   hammer the endpoints.
//! - **Global**: a larger budget for the endpoints as a whole, the backstop for a flood from
//!   many addresses. It is also the only limit that applies when no client address is known.
//!
//! Both are the generic cell rate algorithm (a token bucket that stores one instant per key).
//! The state is in memory, per process: with `n` api instances the global budget is `n` times
//! the figure below, and a restart forgets it, which is acceptable for a limit whose job is
//! to bound abuse rather than to meter usage.
//!
//! # Where the client address comes from
//!
//! Browsers never reach the api (ADR-001, ADR-005): the SvelteKit server calls it over
//! Railway's private network, so the api's TCP peer is always that server and says nothing
//! about the user. The api therefore reads the user's address from `X-Forwarded-For`, and
//! takes the **last** entry: the entry the closest trusted hop wrote. Earlier entries are
//! whatever the caller chose to send and are ignored.
//!
//! That is only sound while two things hold, both deployment facts rather than code:
//!
//! 1. Nothing but the web server can reach the api (the api has no public domain). Anyone who
//!    could call it directly could send any `X-Forwarded-For` and pick a fresh bucket per
//!    request; the global limit would still hold, the per-client one would not.
//! 2. The web server sends the address it verified for the browser connection as the last
//!    entry of `X-Forwarded-For` on every `start` call (`event.getClientAddress()` behind
//!    Railway's edge, which overwrites the header it receives).
//!
//! A request with no usable `X-Forwarded-For` is counted against the global budget only. The
//! TCP peer is deliberately not a fallback: behind the web server it is one shared address,
//! and treating it as a client would let one user's budget throttle everyone. IPv6 clients
//! are keyed by their /64, because a single subscriber normally holds a whole /64 and can
//! rotate addresses within it. Addresses are never logged or stored beyond the bucket map.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use http_kit::{ApiError, ProblemCode};
use tracing::warn;

use crate::AppState;

/// The header the web server fills with the browser's address.
const CLIENT_ADDRESS_HEADER: &str = "x-forwarded-for";

/// How fast a bucket refills and how large a burst it allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    /// Requests allowed back to back after a quiet period.
    pub burst: u32,
    /// Time to earn one more request once the burst is spent.
    pub every: Duration,
}

/// The limits on the passkey `start` endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartLimits {
    /// Each client address (an IPv4 address or an IPv6 /64).
    pub per_client: Rate,
    /// All callers together.
    pub global: Rate,
    /// Most distinct clients tracked at once; past that, new ones count against the global
    /// budget only, so memory stays bounded however many addresses an attacker rotates.
    pub max_clients: usize,
}

impl Default for StartLimits {
    /// Ten starts per client, then one every six seconds (ten a minute); fifty in all, then
    /// five a second. A person signing in or registering needs one or two. These are named
    /// constants because `config.rs` is not in this change's lane: moving them to settings is
    /// a follow-up (ADR-042).
    fn default() -> Self {
        Self {
            per_client: Rate {
                burst: 10,
                every: Duration::from_secs(6),
            },
            global: Rate {
                burst: 50,
                every: Duration::from_millis(200),
            },
            max_clients: 4096,
        }
    }
}

/// Which limit refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The caller's own budget.
    Client,
    /// The endpoints' shared budget.
    Global,
}

/// A request that is over a limit, and how long until it would be allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limited {
    /// The limit that said no.
    pub scope: Scope,
    /// The wait, rounded up to whole seconds and never zero (`Retry-After`).
    pub retry_after: Duration,
}

/// The generic cell rate algorithm for one key: the bucket is the instant `tat` at which it
/// would be empty again; a request is allowed while `tat` is at most `burst - 1` intervals
/// ahead of now.
#[derive(Debug, Clone, Copy)]
struct Cell {
    tat: Instant,
}

impl Cell {
    /// The new state if a request at `now` is allowed, or how long until it would be.
    fn admit(self, rate: Rate, now: Instant) -> Result<Self, Duration> {
        let tolerance = rate.every.saturating_mul(rate.burst.saturating_sub(1));
        let tat = self.tat.max(now);
        let earliest = tat.checked_sub(tolerance).unwrap_or(now);
        if earliest > now {
            return Err(earliest.saturating_duration_since(now));
        }
        Ok(Self {
            tat: tat + rate.every,
        })
    }
}

#[derive(Debug)]
struct State {
    clients: HashMap<IpAddr, Cell>,
    global: Option<Cell>,
}

/// The limiter for the passkey `start` endpoints; cheap to clone, shared by every clone.
#[derive(Debug, Clone)]
pub struct StartLimiter {
    limits: StartLimits,
    state: Arc<Mutex<State>>,
}

impl Default for StartLimiter {
    fn default() -> Self {
        Self::new(StartLimits::default())
    }
}

/// Whole seconds, rounded up, at least one: `Retry-After` takes no fractions.
fn whole_seconds(wait: Duration) -> Duration {
    let seconds = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
    Duration::from_secs(seconds.max(1))
}

impl StartLimiter {
    /// A limiter with these limits and every bucket full.
    #[must_use]
    pub fn new(limits: StartLimits) -> Self {
        Self {
            limits,
            state: Arc::new(Mutex::new(State {
                clients: HashMap::new(),
                global: None,
            })),
        }
    }

    /// Takes one request's worth from the caller's bucket (when its address is known and
    /// tracked) and from the global bucket, or says which refused. A refusal takes nothing,
    /// so a client that is over its limit does not drain the shared budget.
    pub fn check(&self, client: Option<IpAddr>, now: Instant) -> Result<(), Limited> {
        let limits = self.limits;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let state = &mut *state;

        let global = state.global.unwrap_or(Cell { tat: now });
        let global_next = global.admit(limits.global, now);

        let tracked = client.filter(|ip| {
            if state.clients.contains_key(ip) {
                return true;
            }
            if state.clients.len() >= limits.max_clients {
                // Forget clients whose buckets have refilled; they are indistinguishable from
                // new ones.
                state.clients.retain(|_, cell| cell.tat > now);
            }
            state.clients.len() < limits.max_clients
        });
        let client_next = tracked.map(|ip| {
            let cell = state.clients.get(&ip).copied().unwrap_or(Cell { tat: now });
            (ip, cell.admit(limits.per_client, now))
        });

        if let Some((_, Err(wait))) = client_next {
            return Err(Limited {
                scope: Scope::Client,
                retry_after: whole_seconds(wait),
            });
        }
        let global_next = global_next.map_err(|wait| Limited {
            scope: Scope::Global,
            retry_after: whole_seconds(wait),
        })?;
        state.global = Some(global_next);
        if let Some((ip, Ok(cell))) = client_next {
            state.clients.insert(ip, cell);
        }
        Ok(())
    }
}

/// The address `X-Forwarded-For` ends with, normalised for keying; `None` if the header is
/// missing or its last entry is not an address (see the module documentation).
#[must_use]
pub fn client_address(headers: &HeaderMap) -> Option<IpAddr> {
    let last = headers
        .get_all(CLIENT_ADDRESS_HEADER)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .rfind(|entry| !entry.is_empty())?;
    let address = last
        .parse::<IpAddr>()
        .or_else(|_| last.parse::<SocketAddr>().map(|socket| socket.ip()))
        .ok()?;
    Some(normalise(address))
}

/// IPv4-mapped IPv6 addresses count as the IPv4 address; other IPv6 addresses as their /64.
fn normalise(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(_) => address,
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(
            || {
                let [a, b, c, d, ..] = v6.segments();
                IpAddr::V6(Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
            },
            IpAddr::V4,
        ),
    }
}

/// The 429 answer: problem+json with `Retry-After`.
#[derive(Debug)]
pub struct RateLimited(Limited);

impl IntoResponse for RateLimited {
    fn into_response(self) -> Response {
        let seconds = self.0.retry_after.as_secs();
        let mut response = ApiError::new(ProblemCode::RateLimited)
            .detail("Too many attempts. Try again shortly.")
            .into_response();
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

/// Proof that a `start` request is within its limits. Put it before the body extractor, so a
/// refused request is never parsed and never touches the database.
#[derive(Debug, Clone, Copy)]
pub struct StartAllowed;

impl FromRequestParts<AppState> for StartAllowed {
    type Rejection = RateLimited;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let client = client_address(&parts.headers);
        match state.start_limiter().check(client, Instant::now()) {
            Ok(()) => Ok(Self),
            Err(limited) => {
                warn!(scope = ?limited.scope, "passkey start rate limited");
                Err(RateLimited(limited))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    fn limits(client_burst: u32, global_burst: u32) -> StartLimits {
        StartLimits {
            per_client: Rate {
                burst: client_burst,
                every: 10 * SECOND,
            },
            global: Rate {
                burst: global_burst,
                every: SECOND,
            },
            max_clients: 3,
        }
    }

    fn ip(text: &str) -> Option<IpAddr> {
        text.parse().ok()
    }

    fn headers(values: &[&str]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for value in values {
            map.append(CLIENT_ADDRESS_HEADER, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn a_client_gets_its_burst_then_waits_for_the_refill() {
        let limiter = StartLimiter::new(limits(3, 100));
        let t0 = Instant::now();
        for _ in 0..3 {
            limiter.check(ip("203.0.113.7"), t0).unwrap();
        }
        let refused = limiter.check(ip("203.0.113.7"), t0).unwrap_err();
        assert_eq!(refused.scope, Scope::Client);
        assert_eq!(refused.retry_after, 10 * SECOND);

        // Part-way, the wait shrinks (rounded up to whole seconds).
        let refused = limiter
            .check(ip("203.0.113.7"), t0 + Duration::from_millis(5500))
            .unwrap_err();
        assert_eq!(refused.retry_after, 5 * SECOND);
        // One refill later it is allowed once, then refused again.
        limiter.check(ip("203.0.113.7"), t0 + 10 * SECOND).unwrap();
        assert!(limiter.check(ip("203.0.113.7"), t0 + 10 * SECOND).is_err());
    }

    #[test]
    fn clients_do_not_share_a_budget() {
        let limiter = StartLimiter::new(limits(1, 100));
        let t0 = Instant::now();
        limiter.check(ip("203.0.113.1"), t0).unwrap();
        assert!(limiter.check(ip("203.0.113.1"), t0).is_err());
        limiter.check(ip("203.0.113.2"), t0).unwrap();
    }

    #[test]
    fn the_global_budget_caps_many_clients_together() {
        let limiter = StartLimiter::new(limits(10, 2));
        let t0 = Instant::now();
        limiter.check(ip("203.0.113.1"), t0).unwrap();
        limiter.check(ip("203.0.113.2"), t0).unwrap();
        let refused = limiter.check(ip("203.0.113.3"), t0).unwrap_err();
        assert_eq!(refused.scope, Scope::Global);
        assert_eq!(refused.retry_after, SECOND);
        limiter
            .check(ip("203.0.113.3"), t0 + SECOND)
            .expect("the global budget refills");
    }

    #[test]
    fn a_refused_client_does_not_drain_the_global_budget() {
        let limiter = StartLimiter::new(limits(1, 2));
        let t0 = Instant::now();
        limiter.check(ip("203.0.113.1"), t0).unwrap();
        for _ in 0..20 {
            assert_eq!(
                limiter.check(ip("203.0.113.1"), t0).unwrap_err().scope,
                Scope::Client
            );
        }
        // One global token is left for someone else.
        limiter.check(ip("203.0.113.2"), t0).unwrap();
    }

    #[test]
    fn a_request_without_an_address_counts_against_the_global_budget_only() {
        let limiter = StartLimiter::new(limits(1, 3));
        let t0 = Instant::now();
        for _ in 0..3 {
            limiter.check(None, t0).unwrap();
        }
        assert_eq!(limiter.check(None, t0).unwrap_err().scope, Scope::Global);
    }

    #[test]
    fn rotating_addresses_cannot_grow_the_table_past_its_cap() {
        let limiter = StartLimiter::new(limits(1, 1000));
        let t0 = Instant::now();
        for n in 0..50_u8 {
            limiter
                .check(ip(&format!("198.51.100.{n}")), t0)
                .expect("each new address has its own bucket or only the global one");
        }
        let tracked = limiter.state.lock().unwrap().clients.len();
        assert!(tracked <= 3, "{tracked} clients tracked");
    }

    #[test]
    fn refilled_clients_are_forgotten_to_make_room() {
        let limiter = StartLimiter::new(limits(1, 1000));
        let t0 = Instant::now();
        for n in 0..3_u8 {
            limiter.check(ip(&format!("198.51.100.{n}")), t0).unwrap();
        }
        // Later every bucket is full again, so a newcomer displaces them instead of being
        // untracked.
        let later = t0 + 60 * SECOND;
        limiter.check(ip("198.51.100.99"), later).unwrap();
        assert!(
            limiter
                .check(ip("198.51.100.99"), later)
                .is_err_and(|l| l.scope == Scope::Client)
        );
    }

    #[test]
    fn the_last_forwarded_entry_is_the_client_and_earlier_ones_are_ignored() {
        assert_eq!(
            client_address(&headers(&["203.0.113.9"])),
            ip("203.0.113.9")
        );
        // A caller-supplied chain: the entry the trusted hop appended wins.
        assert_eq!(
            client_address(&headers(&["1.2.3.4, 5.6.7.8, 203.0.113.9"])),
            ip("203.0.113.9")
        );
        // Several header lines count as one chain, in order.
        assert_eq!(
            client_address(&headers(&["1.2.3.4", "203.0.113.9"])),
            ip("203.0.113.9")
        );
        assert_eq!(
            client_address(&headers(&["203.0.113.9:4711"])),
            ip("203.0.113.9")
        );
        assert_eq!(
            client_address(&headers(&["203.0.113.9, "])),
            ip("203.0.113.9"),
            "a trailing comma is not an entry"
        );
    }

    #[test]
    fn unusable_headers_yield_no_address() {
        assert_eq!(client_address(&HeaderMap::new()), None);
        for bad in ["", "unknown", "1.2.3.4, unknown", "not an ip", "999.1.1.1"] {
            assert_eq!(client_address(&headers(&[bad])), None, "{bad:?}");
        }
    }

    #[test]
    fn ipv6_clients_are_keyed_by_their_slash_64_and_mapped_ipv4_by_its_address() {
        let a = client_address(&headers(&["2001:db8:1:2:aaaa:bbbb:cccc:dddd"]));
        let b = client_address(&headers(&["[2001:db8:1:2::1]:443"]));
        let other = client_address(&headers(&["2001:db8:1:3::1"]));
        assert_eq!(a, b);
        assert_ne!(a, other);
        assert_eq!(a, ip("2001:db8:1:2::"));
        assert_eq!(
            client_address(&headers(&["::ffff:203.0.113.9"])),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn retry_after_is_whole_seconds_and_never_zero() {
        assert_eq!(whole_seconds(Duration::from_millis(1)), SECOND);
        assert_eq!(whole_seconds(Duration::ZERO), SECOND);
        assert_eq!(whole_seconds(SECOND), SECOND);
        assert_eq!(whole_seconds(Duration::from_millis(1001)), 2 * SECOND);
    }
}
