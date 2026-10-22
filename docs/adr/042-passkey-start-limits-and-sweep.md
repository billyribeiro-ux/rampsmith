# ADR-042: Rate limits on the passkey start endpoints, and the sweep of expired sign-in state

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-024 (passkeys and dashboard sessions)
- Source: R0 security audit finding M6 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

`POST /v1/auth/register/start` and `POST /v1/auth/sign-in/start` take no credentials, and each
inserts a `webauthn_ceremonies` row holding WebAuthn state. Nothing limited them, and nothing
deleted a ceremony (five-minute life) or a session (up to thirty days) after it expired. Anyone
who could reach the api could fill the table, and `register/start` also answers 409 for an email
that already has an account, so it doubled as an enumeration oracle.

The api is not reachable from browsers: the SvelteKit server calls it over Railway's private
network (ADR-001, ADR-005). That decides where the "client address" can come from.

## Decision

### 1. Two limits, before any work

`api::rate_limit::StartAllowed` is an extractor placed in front of the body extractor on both
`start` handlers, so a refused request is neither parsed nor stored. Both endpoints share one
budget; `finish`, `session` and every other route are not limited by it.

| Limit | Burst | Refill | Why |
|---|---|---|---|
| per client | 10 | one per 6 s (10 a minute) | A person needs one or two starts; this stops one source hammering. |
| global | 50 | 5 a second | Backstop for a flood from many addresses; bounds ceremony rows to a few thousand per sweep period. |

Both are the generic cell rate algorithm: a token bucket stored as one instant per key. A
refusal takes nothing from either bucket, so a client that is over its limit cannot drain the
shared one. The answer is **429** `application/problem+json` with code `rate_limited` and a
`Retry-After` header in whole seconds (at least 1). The log line names only the scope (client or
global); addresses are personal data and are never logged.

The state is in memory, per api instance: with `n` instances the global budget is `n` times the
table, and a restart forgets it. That is enough for a limit whose job is to bound abuse. The
figures are named constants in `StartLimits::default()` because `crates/api/src/config.rs` is
outside this change's lane; making them settings is a follow-up.

### 2. The client-address trust boundary

The api reads the address from `X-Forwarded-For` and takes the **last** entry, the one the
closest trusted hop wrote. Earlier entries are whatever the caller sent and are ignored (a test
sends invented chains and shows they buy no fresh budget). IPv4-mapped IPv6 counts as the IPv4
address; other IPv6 addresses count as their /64, since one subscriber holds a whole /64.

This is sound only while two deployment facts hold. They are requirements on other parts of the
system, recorded here so they are not lost:

1. **Nothing but the web server can reach the api.** The api has no public domain and listens on
   the private network only. A caller that could reach it directly could pick any
   `X-Forwarded-For` and get a fresh per-client budget on every request. The global limit would
   still hold.
2. **The web server sends the address it verified**, as the last entry of `X-Forwarded-For`, on
   every `start` call. Behind Railway's edge that is `event.getClientAddress()` with
   `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` (adapter-node reads from the right).
   Railway documents that its edge sets the real address; it does not document that it
   overwrites a client-supplied `X-Forwarded-For`, so the web server must not forward the raw
   inbound header. (Work for `apps/web`, not part of this change.)

A request with no usable `X-Forwarded-For` counts against the **global budget only**. The TCP
peer is deliberately not a fallback: behind the web server it is always the same address, and
using it would let any one user's per-client budget throttle everybody. Per-client tracking is
capped at 4,096 addresses; beyond that, and after forgetting clients whose buckets have
refilled, new addresses are counted globally only, so rotating addresses cannot grow memory.

### 3. The sweep

`identity_sweep()` (migration `20261101000001`) deletes expired sessions and ceremonies by the
database clock and returns how many rows went. It is `SECURITY DEFINER` and executable by
`rampsmith_worker` only: `ctl` has no grants on the identity tables (migration 6 says "workers
have no grants", and `the_worker_role_cannot_read_identity` keeps it true), and the api has no
use for it. It takes no argument, so a caller can delete only what is already expired.

The `ctl` leader runs it through `db::repo::identity::sweep` every ten minutes
(`Cadence::sweep_every`) beside the lease reaper and partition maintenance, so exactly one
instance does it. A failed sweep logs and retries on the next tick.

## Consequences

- An unauthenticated flood is bounded in rows and in work: 50 starts at once, then 5 a second
  across all callers, 10 then 10 a minute per client.
- A legitimate user behind a shared address (an office, a carrier-grade NAT) shares 10 starts a
  minute with their neighbours. Sign-in needs one; registration two. Acceptable for R1.
- The web server's `X-Forwarded-For` behaviour is now a security control. If it forwards the
  raw inbound header and the edge does not overwrite it, per-client limiting degrades to the
  global limit's protection, never to none.
- `register/start` still reveals whether an email is registered (409). The limit bounds the
  rate of that oracle; closing it needs the email-first design of R2.

## Plan correction

PLAN §16 (Sign-in): add "The unauthenticated `start` calls are rate limited per client and
globally (ADR-042); expired ceremonies and sessions are swept by the `ctl` leader."

## Rejected alternatives

- **Limit by the TCP peer address.** Always the web server's private address.
- **A limiter in the web server only.** The api is the component that owns the table; a second
  caller of the api (a script on the private network, a future service) would bypass it.
- **A Postgres-backed counter.** Shared across instances, but every request would write, which
  is the cost the limit exists to avoid.
- **Granting the worker `delete` on the identity tables.** Gives a compromised `ctl` the power
  to read and rewrite credentials. The definer function can only delete the already dead.
- **Passing `now` to the sweep.** The test clock would be convenient, but a caller could then
  delete every live session.
