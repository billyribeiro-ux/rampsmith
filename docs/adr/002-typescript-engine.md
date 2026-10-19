# ADR-002: TypeScript for the engine

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

The scanning and patching engine depends on axe-core, Playwright, `@shopify/liquid-html-parser`, `@shopify/theme-check-node` and the Anthropic SDK. All of them are first-party JavaScript; Anthropic ships no Rust SDK.

## Decision

Write `packages/engine` and its libraries (`liquid-patch`, `a11y-rules`) in TypeScript on Node 26, under the same strict compiler settings as the web app (PLAN §8).

## Consequences

- The engine and the Rust services share no code at runtime; they share the database and generated contracts (ADR-003, ADR-009).
- The job queue protocol is implemented twice, once per language, against one table and one shared test plan.

## Rejected alternatives

- `chromiumoxide` in Rust: community-maintained, last release February 2026, no axe integration.
