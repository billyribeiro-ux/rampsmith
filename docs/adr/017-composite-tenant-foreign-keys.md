# ADR-017: Composite tenant foreign keys

- Status: Accepted
- Date: 2026-10-17
- Amends: PLAN §9 (core tables)

## Context

ADR-006 isolates tenants twice: repository functions filter by `TenantTx`, and row-level
security filters every statement. Neither covers references between rows. PostgreSQL checks
foreign keys without applying row-level security, so with plain `site_id uuid references
sites(id)` a bug could store tenant A's finding against tenant B's site; the row would pass
A's policy because its own `tenant_id` is A.

The plan's `fix_findings` table also has no `tenant_id`, so row-level security cannot apply
to it at all.

## Decision

- Every referenced tenant-owned table has `unique (id, tenant_id)`.
- Every reference between tenant-owned rows is a composite foreign key
  `(x_id, tenant_id) references x (id, tenant_id)`, so both rows must share a tenant. This
  holds for every role, including the owner.
- `fix_findings` gains `tenant_id uuid not null` and the same policy as every other table.
- `scans` and `fixes` gain `created_at timestamptz not null default now()`, for ordering
  queued work and listings.
- Checks the plan implies are enforced in the schema: data fixes only through
  `admin_api`; an AI fix names its model and prompt version; `approved_by` and
  `approved_at` are set together; HTML excerpts are at most 512 characters.

## Consequences

- One more index per referenced table (the composite unique key).
- The isolation suite proves cross-tenant references fail even for the owner.
- Each `finding_occurrences` partition carries its own policy, because a parent's policy
  does not apply to direct queries on a partition.

## Rejected alternatives

- Triggers that compare tenants on insert: slower, easy to forget on a new table, and
  invisible in the schema.
- Trusting repository code alone: the point of ADR-006 is that one mistake is not enough.
