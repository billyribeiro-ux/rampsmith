# ADR-006: Shared schema with tenant_id, enforced twice

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Rampsmith will hold thousands of stores in one PostgreSQL database. A single missed `WHERE tenant_id = ...` must not be able to leak data across tenants.

## Decision

Every tenant-owned table carries `tenant_id uuid not null` and a row-level security policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. The application role has no `BYPASSRLS` and does not own the tables. The Rust `TenantTx` type opens each transaction with `SET LOCAL app.tenant_id`, and repository functions accept only `&mut TenantTx`, so unscoped access does not compile. An isolation suite creates two tenants and asserts that every repository function returns nothing across the boundary.

## Consequences

- Two independent layers: compile-time scoping and database enforcement.
- System jobs set the tenant per job; cross-tenant reads exist only in `rsctl` and are audited.

## Rejected alternatives

- Schema per tenant: migration fan-out at thousands of stores.
