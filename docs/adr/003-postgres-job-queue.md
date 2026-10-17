# ADR-003: PostgreSQL is the job queue

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Rust (`ctl`) and TypeScript (`engine`) workers both need durable, transactional background jobs. Jobs must enqueue in the same transaction as the domain write that causes them, survive worker crashes, and never produce a duplicated side effect.

## Decision

Jobs are rows in the `jobs` table, claimed with `FOR UPDATE SKIP LOCKED` under a lease, woken by `LISTEN/NOTIFY` with a 5-second poll as backstop. Both languages implement the same five operations (enqueue, claim, heartbeat, complete, fail) from PLAN §10. The attempt number is a fencing token on completion.

## Consequences

- One stateful store to back up and restore.
- Delivery is at least once, so every side effect must be idempotent (compare-before-write, deterministic branch names, idempotency keys).
- Throughput is bounded by PostgreSQL; the `rsctl bench` load test measures it before it matters.

## Rejected alternatives

- Redis or a message broker: another stateful service and no transactional enqueue. `pg-boss` or `apalis`: each owns its schema in one language only.
