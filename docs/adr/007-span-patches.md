# ADR-007: Patches edit source spans only

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Themes connected through Shopify's GitHub integration receive merchant edits continuously. Whole-file rewrites would bury the fix and conflict with those edits.

## Decision

Code fixes are edits of the form `{file, start, end, replacement}` computed from `@shopify/liquid-html-parser` node positions, applied from the end of the file backwards. Files are never reprinted or reformatted.

## Consequences

- Minimal diffs that preserve merchant formatting and rebase cleanly.
- Every recipe must detect an already-applied fix, so re-running it is a no-op.

## Rejected alternatives

- Reformatting with the Liquid Prettier plugin: whole-file diffs that bury the fix.
