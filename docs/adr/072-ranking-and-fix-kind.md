# ADR-072: Dedupe, ranking and fix kind

- Status: Accepted
- Date: 2026-10-22
- Source: R1 lane B; implements PLAN §11

## Decision

- A render finding's fingerprint is the rule, the scrubbed element target and its theme section (`fingerprint.ts`), so the same defect on ten products is one finding with ten occurrences (at most 25 stored per finding and state). A data finding's fingerprint is content-based (rule, resource, field, snippet, ordinal).
- Priority score = impact weight (critical 8, serious 4, moderate 2, minor 1) x templates affected x 2 on a purchase path (product, cart, search). Ties break on WebAIM Million 2026 prevalence, then fixability (data before code before manual), then rule id, then finding id. Best-practice results are never ranked.
- Each finding is marked `fix_kind`: `data` (media alt, menu label, rich text), `code` (a recipe from the fix catalogue) or `manual`.
- Finalize closes a finding only when its previous occurrences' pages were reloaded in this scan and it did not recur; a page that failed or was blocked never closes anything.

## Consequences

Coverage is disclosed per scan in `scans.coverage` (ADR-225): pages planned, loaded, blocked, failed, and criteria tested.
