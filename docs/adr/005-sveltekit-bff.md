# ADR-005: SvelteKit is a backend-for-frontend

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

The embedded Shopify admin runs in an iframe, and the standalone dashboard needs passkeys. Calling the Rust API directly from browsers would widen the attack surface and require CORS against the admin iframe.

## Decision

Browsers talk only to `web` (SvelteKit). SvelteKit's server calls `api` over Railway private networking with the generated OpenAPI client. Session tokens are forwarded server-side; no token is exposed to browser code beyond what App Bridge already holds.

## Consequences

- One origin per surface, simpler CSP and no CORS.
- `api` is not reachable from the public internet except for the webhook host.

## Rejected alternatives

- Browser calls to `api`: wider attack surface, CORS against the admin iframe.
