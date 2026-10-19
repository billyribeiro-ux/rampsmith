# ADR-004: Never write theme files; three fix channels

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Shopify does not let App Store apps create, change or delete theme files without an exemption that is rarely granted; `themeCreate` needs the same exemption. Reading theme files is allowed (PLAN §4).

## Decision

Rampsmith never writes merchant theme files through any API. Fixes ship through three channels only: store data through the Admin GraphQL API, GitHub pull requests against a connected theme repository, and a patched theme package the merchant installs as an unpublished theme. Rampsmith never publishes a theme and never adds an overlay or toolbar widget.

## Consequences

- No feature depends on a theme-write exemption; an exemption, if ever granted, is upside only.
- The patched package is optional and framed as a developer handoff.

## Rejected alternatives

- An overlay widget: it does not fix source and does not stop suits.
