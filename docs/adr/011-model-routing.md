# ADR-011: Claude model routing by task difficulty

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Claude drafts alt text, rewrites descriptions, breaks source-mapping ties and proposes patches for custom widgets. These tasks differ widely in difficulty and volume.

## Decision

Use `claude-haiku-5-5` by default, escalate to `claude-sonnet-5-5`, and use `claude-opus-5-5` only for offline patch synthesis (PLAN §13). Model ids are pinned snapshots; a model review happens at every new model release.

## Consequences

- Cost per task ordered by difficulty; alt text costs about $0.10 per 1,000 images on the Batch API.
- Every call is logged with model, tokens, cost and prompt version.

## Rejected alternatives

- One model for everything.
