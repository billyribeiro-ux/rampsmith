# ADR-012: No Redis in R0 to R2

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Rate limits, caches and queues are the usual reasons to add Redis.

## Decision

Do not run Redis in R0 to R2. Rate limits use `governor` in process; caches live in process or in PostgreSQL; the queue is PostgreSQL (ADR-003).

## Consequences

- One less stateful service to secure, back up and monitor.
- Revisit only with a measured need.

## Rejected alternatives

- Redis "just in case".
