# ADR-018: Job queue protocol details

- Status: Accepted
- Date: 2026-10-17
- Refines: PLAN §10, ADR-003

## Context

PLAN §10 fixes the table, the claim query and the five operations. Building them in Rust
(`crates/queue`) and TypeScript (`packages/queue`) needed decisions the plan leaves open.

## Decision

1. **Row-level security on `jobs`, per role.** Workers claim across tenants, so the
   `rampsmith_worker` policy is `using (true)`. The `rampsmith_app` policy limits the API to
   its own tenant's jobs, and it may only insert and read, never claim. `tenant_id` stays
   nullable for system jobs.
2. **Enqueue inside the tenant transaction.** `db::repo::jobs::enqueue(&mut TenantTx, job)`
   forces the job's tenant to the transaction's tenant; `pg_notify('jobs', queue)` fires on
   commit, so a rolled-back domain write leaves no job behind.
3. **Fencing everywhere.** Heartbeat, complete and fail all match
   `id, locked_by, attempts, state = 'running'`. A lost lease surfaces as
   `LeaseLost`; the worker abandons the attempt without side effects of its own.
4. **The reaper** (run by the `ctl` leader) returns jobs whose lease expired to `ready`
   immediately, recording `{"code": "lease_expired"}`, or buries them as `dead` when no
   attempts remain. Claims never take expired leases directly, so the `jobs_ready` partial
   index stays the only claim path.
5. **Retry delay** = `e/2 + ⌊jitter × e/2⌋` with `e = min(1 h, 5 s × 2^(attempt−1))`
   (exponential with equal jitter). Both languages test against
   `crates/queue/testdata/backoff.json`. Jitter comes from `rand` 0.10.3 (crates.io,
   2026-09-20, MSRV 1.85), the one new runtime dependency.
6. **`last_error`** has one shape, `contracts::JobError {code, message, retryable}`,
   generated to TypeScript like every contract. `retryable` records whether the job was in
   fact rescheduled. Messages never carry tokens, theme source or personal data.
7. **States.** `dead` covers permanent failures and exhausted attempts; it alerts and is
   retried only by `rsctl jobs retry` (`retry_dead`, which resets the attempt budget).
   `failed` stays in the check constraint as the plan defines it, but no code path writes
   it in R0.
8. **Worker loop.** Heartbeat every third of the lease; drop the handler when a heartbeat
   finds the lease lost; poll every 5 seconds besides `LISTEN`; on shutdown, stop claiming
   and wait for attempts in flight.
9. **Proof of the exit criterion.** `crates/queue/tests/kill.rs` runs a real worker process
   (`queue-harness`, a test fixture binary that is never deployed), kills it with SIGKILL
   while jobs hang before and after their side effect, reaps, and lets a second worker
   finish. It asserts every job succeeded, every effect exists exactly once, and each was
   written by the expected attempt.

## Consequences

- Side effects must be idempotent: the kill test's "after effect" case runs the handler
  twice by design.
- The TypeScript engine relies on the Rust `ctl` leader to reap expired leases.

## Rejected alternatives

- Claiming expired leases in the claim query: needs a second index scan on every claim and
  hides crashed workers from metrics.
- Full jitter (`⌊jitter × e⌋`): allows near-zero delays that hammer a throttled provider.
