# ADR-047: A failed leader check abandons the connection, and `jobs` joins the isolation suite

- Status: Accepted
- Date: 2026-10-19
- Refines: PLAN §10 (leadership), ADR-006 (shared schema and row-level security)
- Source: R0 security audit finding L12 (`docs/evidence/r0-security-audit-2026-10-19.md`) and
  the isolation suite's gap for `jobs`

## Context

### The leader connection

Leadership is a session-level advisory lock on one dedicated connection (`ctl::leader`). Every
tick the leader runs `select 1` on that connection; if it fails, the loop stops leading. But the
connection was a `PoolConnection`, and leaving the loop dropped it, which hands it back to the
pool. A query can fail on a connection that is still open: after an error inside a transaction
(`current transaction is aborted`), on a statement timeout, on a cancelled query. Such a
connection still holds the advisory lock, so after the "failed" leader gave up, nobody was
leader: other instances' `pg_try_advisory_lock` kept failing, and this instance's own retries
could be served the same pooled connection, where the lock is re-entrant. Duties stopped until
the process was restarted.

### The isolation suite and `jobs`

`jobs` is a tenant table with a nullable `tenant_id` (system jobs have none) and policies per
role: workers see every job, the application role sees its own tenant's and may insert and
select only. The suite's table list (`TENANT_TABLES`) did not include it, so nothing checked
that the application role cannot see another tenant's jobs or the system's.

## Decision

1. **`leader::keep_or_drop(connection)`** runs the liveness query. On success it returns the
   connection. On failure it logs, **detaches the connection from the pool and closes it**
   (waiting at most five seconds, then dropping it), and returns `None`; the loop leaves
   leadership. Closing the session releases the advisory lock on the server, and the pool
   opens a fresh connection for the next attempt.
2. **`jobs` is in `TENANT_TABLES`**, and the suite is stricter about it:
   - The suite seeds one job per tenant (through `jobs::enqueue`) and one system job with no
     tenant, so "nothing foreign is visible" cannot be satisfied by an empty table.
   - The foreign-row query uses `is distinct from`, not `<>`, so a row with no tenant counts as
     foreign for the application role. (`<>` with a null is null, and the row would not count.)
   - New tests: each tenant sees exactly its own job; workers see all three; the application role
     can enqueue for its own tenant only (a null tenant and another tenant's id are refused by
     the row-level security check), can never update or delete a job (no privilege), and workers
     can update every tenant's jobs.

## Consequences

- A leader that loses a working connection is replaced within one retry interval, by itself or
  by another instance, with no manual restart.
- Detaching frees a pool slot, so the pool briefly holds one connection fewer; it reconnects on
  demand.
- A regression in `jobs` policies fails the isolation suite with a message naming the table.

## Plan correction

None; PLAN §10 already says losing the connection loses leadership. This makes the code do it.

## Rejected alternatives

- **Release the lock explicitly with `pg_advisory_unlock` before dropping.** The connection that
  failed its query often cannot run it either (an aborted transaction), and a connection that
  cannot be trusted should not be reused at all.
- **Roll the transaction back and keep the connection.** Fixes one failure mode and keeps the
  leader tied to a session whose state is unknown.
- **Skip `jobs` in the "never nullable" and cross-tenant checks because of system jobs.** The
  system rows are exactly what the application role must not see.
