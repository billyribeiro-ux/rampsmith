# ADR-044: Exchange writes are compare-and-swap

- Status: Accepted
- Date: 2026-10-19
- Amends: ADR-022 (Shopify authentication and the token lifecycle), decision 4
- Source: R0 security audit finding L5 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

ADR-022 decision 4 says the token row "carries a `version` column and every write is a
compare-and-swap on it; a lost race re-reads instead of overwriting". `rotate` (refresh) did
that. `put_tokens` (token exchange) did not: it was an unconditional upsert that replaced the
row and incremented `version`. Under the shop's advisory lock that is safe against every
in-band writer, which is why nothing failed, but the lock is the only thing it relied on. A
writer that does not take the lock (an operator repairing a row, a restore from backup, the
key-rotation job of ADR-045 if it ever bumped the version) would be overwritten silently, and
the ADR's second line of defence would not exist.

## Decision

Make the code say what the ADR says.

1. `db::repo::shopify::put_tokens(tx, shop, expected_version, tokens)` takes the state the
   caller read: `None` for "I found no token row", `Some(v)` for "I found it at version v". It
   returns `Some(new version)` when the row was still like that and `None` when it was not,
   changing nothing. `Some(v)` is `rotate`; `None` is an `insert ... on conflict do nothing`.
   A shop that belongs to another tenant answers `None` as well: the repository never
   overwrites a row it cannot see.
2. `ShopifyAuth::authenticate_at` reads the token row under the shop's lock, **before** the
   call to Shopify, and passes that version on. The whole slow window of the exchange is
   therefore covered, not just the instant between a read and a write. On `None` the exchange
   fails with `DbError::Conflict` (the api answers 409), and the transaction rolls back: no
   shop, token, job or audit row is written.
3. A lost compare-and-swap on exchange is an error, not a retry. Every in-band writer holds
   the lock, so the only way to lose is an out-of-band write, which is exactly the situation a
   person should hear about. The merchant's next app open runs the exchange again against the
   row as it now is. (A lost compare-and-swap on refresh keeps the stored pair and returns
   `Fresh`, as before; this ADR does not change it.)

## Consequences

- ADR-022 is now true as written. The tokens of a shop can only be replaced by a writer that
  saw the current row, with or without the lock.
- An exchange that races an out-of-band write costs one failed app open (409). The pair Shopify
  issued for it is dropped; Shopify issues a new one next time.
- `put_tokens` no longer returns `Forbidden` for another tenant's shop; the composite foreign
  key still rejects an insert for a shop the tenant does not own, and the isolation suite
  (`tests/tenancy.rs`) asserts that neither claim overwrites the other tenant's row.

## Plan correction

None. PLAN §14 says only that rotation is a compare-and-swap, which it still is.

## Rejected alternatives

- **Amend ADR-022 to say the lock alone serialises exchange.** Simpler, but it removes the
  defence that does not depend on every caller remembering the lock, and the version column
  already exists.
- **Retry the exchange on a lost compare-and-swap.** It would discard a valid pair and call
  Shopify again to paper over an out-of-band write that someone should look at.
