# ADR-070: Scan planning, sampling and progress

- Status: Accepted
- Date: 2026-10-22
- Source: R1 lane B (scan pipeline)

## Context

The engine never holds a Shopify token (ADR-035). `ctl` reads the store into `scan_inputs` (kinds `shop`, `products`, `collections`, `pages`, `articles`, `menus`, `verify`) and the engine plans from those rows under row-level security. The entitlement lives in Rust (`crates/billing`), which TypeScript cannot import.

## Decision

- `scan.plan@1` is a pure function of the inputs (`planPages`): home, cart, search and login are fixed; product, collection, page and article URLs come from handles, spread evenly across the list, variants (template suffixes) taken in turn. The sampling is read from the `shop` input (`sampling`: `{mode:'home_plus', pages}` or `{mode:'per_template', samples, every_variant}`) and defaults to Starter (3 per template). Free is the home page plus five pages, Growth ten, Pro every variant up to 25.
- The plan is stored on `scans.plan` and reused on a retry; one `scan.page@2` job per page, idempotency key `scan.page:<scan>:<seq>`.
- Interactive states and the custom keyboard, reflow, spacing and autoplay checks run on the first sample of each page type only; one mobile page per type.
- `pages_done` counts one per `scan.page` job (not per state). A scan is complete when `pages_done >= pages_planned` and `inputs_done >= data_inputs_planned`; the job that completes it enqueues `scan.finalize@1` (key `scan.finalize:<scan>`).
- Payload parsers accept the Admin API spelling and the database spelling and drop one unreadable item rather than the batch.

## Consequences

`ctl` must write the `shop.sampling` object and every `scan_inputs` row before it enqueues `scan.plan@1`. Migration `20261104000001` (in `crates/db`, lane B's number range) widens the `scan_pages` key to `(scan, url, state, viewport)`.
