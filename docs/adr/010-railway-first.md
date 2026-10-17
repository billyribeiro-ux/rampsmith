# ADR-010: Railway first, with a measured move of browser workers

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Rampsmith starts with no customers. Idle infrastructure cost should be near zero, and the founder already deploys on Railway.

## Decision

Run every service on Railway with usage-based billing and Railway PostgreSQL with point-in-time recovery. When `engine` compute stays above $100 a month for two consecutive months, the same image moves to dedicated hardware and connects back over TLS.

## Consequences

- No Kubernetes to operate.
- Moving `engine` is an operational change, not a code change, because it only talks to PostgreSQL, R2, Anthropic and `egress`.

## Rejected alternatives

- Kubernetes on day one: operations cost with no customer to justify it.
