# ADR-041: The per-shop token lock holds one connection and waits a bounded time

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-022 (Shopify authentication and the token lifecycle)
- Source: R0 security audit finding M5 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

ADR-022 serialises token exchange and refresh for one shop with a transaction-scoped advisory
lock, `pg_advisory_xact_lock(hashtextextended('shopify.shop:' || domain, 0))`. The R0
implementation had three faults that together let a burst of cold app opens starve every tenant
of the api's database pool:

1. A request waiting for the lock waited without a limit, **holding a pool connection**.
2. The holder needed a **second** connection while it held the first: the re-check
   (`usable_shop`) and the store (`store_exchanged`) each opened their own transaction.
3. Every waiter for the same shop took a connection, although only one of them could ever run.

With the default pool of ten, ten simultaneous first opens of one shop (a merchant reopening a
tab, or a retry storm after a Shopify outage) took all ten connections: nine waiting for the
lock, one holding it and unable to get the second it needed. Every other tenant's request then
waited out the five-second acquire timeout. The new test
`a_burst_of_cold_opens_on_a_small_pool_completes` (a pool of three, twenty simultaneous first
opens of two shops) fails when the in-process queue is switched off and passes with it.

## Decision

`Db::shop_lock` (`crates/db/src/tx.rs`) now has four properties.

1. **In-process single flight (`crates/db/src/flights.rs`).** Requests for one shop queue on an
   in-memory mutex first, holding no connection. At most one request per shop per process ever
   reaches the database. The queue entry is removed when the last request leaves, so the map
   stays as small as the number of shops being exchanged at that moment, and a cancelled request
   (a client that went away) leaves nothing behind.
2. **A share of the pool.** The number of shops that may hold a connection for a lock at the
   same time is half the pool, at least one. Everyone else (other tenants, the readiness check,
   the next request for an already-installed shop) keeps the other half. The share is derived
   from the pool's `max_connections`, so no new setting is needed.
3. **A bounded wait in the database.** The lock's transaction first runs
   `set_config('lock_timeout', '<n>ms', true)` (the `SET LOCAL` form), then takes the lock. When
   another process holds it longer than `SHOP_LOCK_TIMEOUT` (15 seconds: longer than the 10
   second Shopify call a holder makes, so an honest holder finishes first), Postgres answers
   `55P03` (verified: `lock_timeout` applies to advisory locks), which becomes
   `DbError::LockTimeout`. The failed transaction is rolled back at once so the connection
   returns to the pool before the error is reported. The api answers **503** `unavailable` with
   no retry header; the embedded app retries on its own.
4. **One connection per holder.** The `ShopLock` guard carries its transaction on.
   `ShopLock::shop_by_domain` does the re-check on it, and `ShopLock::into_tenant(tenant)` scopes
   the same transaction to the tenant (`set_config('app.tenant_id', .., true)`), returning a
   `TenantTx` that still holds the lock and the shop's place in the queue. Install, token
   storage, the keep-alive job and the audit entry run in that one transaction and commit
   together, so a failure between the pieces no longer leaves a half-installed shop. The refresh
   path (`refresh_if_due`) does the same.

The advisory lock is still the cross-process guarantee; the in-process queue only keeps waiting
off the pool. Row-level security is unchanged: the tenant is set on the transaction before any
tenant row is read or written, and the only statement that runs before it is the
`SECURITY DEFINER` function `app_shop_by_domain` (ADR-022), which is exactly what ran before.

A handle built with `Db::from_pool` owns its queue; clones share it. Two handles over one pool
(only the tests do this, to model a second process) do not.

## Consequences

- A burst of N cold opens of one shop uses one connection plus N in-memory waiters. A burst
  across many shops uses at most half the pool and queues the rest, in memory, in arrival order.
- A stuck holder (a Shopify call that never returns) costs waiters at most 15 seconds, not the
  rest of the pool. The Shopify client's own 10-second timeout still ends the holder first.
- The token exchange call to Shopify now happens inside an open transaction on the lock's
  connection, as the holder did before; what changed is that nothing else queues behind it on
  the pool.
- Log lines in `shopify-auth` name the shop by id, never by domain (audit L7).

## Plan correction

PLAN §14 step 4 ("serialise exchange per shop with an advisory lock"): add "the lock is taken on
one connection with a bounded wait, behind an in-process queue per shop (ADR-041)".

## Rejected alternatives

- **`pg_try_advisory_xact_lock` in a retry loop.** It bounds the wait but turns a queue into
  polling, with jitter to tune and no fairness, and it still needs the in-process queue to keep
  waiters off the pool.
- **A separate small pool for lock holders.** It isolates the damage but adds a setting and a
  second set of connections per process (the api config file is outside this lane), and the
  holder would still need to reach the tenant tables from the other pool.
- **Dropping the lock and relying on the unique constraints.** Exchange retires every other
  token of the app on the shop; two concurrent exchanges would leave one request holding a dead
  token. That is the reason ADR-022 has the lock.
