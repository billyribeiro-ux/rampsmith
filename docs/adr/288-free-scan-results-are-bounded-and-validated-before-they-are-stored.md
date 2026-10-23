# ADR-288: Free-scan results are bounded and validated before they are stored

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-267
- Source: audit of the R1 integration, finding L5

## Context

The result limits covered the number of groups, examples and pages and the snippet length, but not
the length of the page addresses, rule ids, titles, criteria or domain. A page can link to an
address of any length, and the engine wrote whatever it built.

## Decision

- `crates/contracts/src/free_scan.rs` caps a page or example address at 2048 characters
  (`MAX_URL_CHARS`), a rule id and criterion at 120, a title and snippet at 240, the domain at 253,
  and states the counts as schema limits (`pages` at most 3, `failures` at most 20, `examples` at most
  3). `within_limits` checks all of them, so the api refuses to serve a result that breaks one. The
  generated JSON Schema and TypeScript are regenerated.
- The engine drops a link longer than 2048 characters in `chooseLinks`, cuts a rule id and criterion
  to 120, and validates the finished result against the generated schema (`isFreeScanResult`) before it
  writes it; a result that does not match fails the scan (`free_scan_result_invalid`, permanent)
  instead of being stored.
- Tests: `crates/contracts` (`addresses_are_capped_at_2048_characters`), `packages/engine/test/free-scan.test.ts`.

## Consequences

The stored result is always one the api will serve and the page can show.
