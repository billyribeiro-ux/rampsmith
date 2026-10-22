# ADR-260: The free scanner codes to an engine seam that is not connected yet

- Status: Accepted
- Date: 2026-10-22

## Context

PLAN §16 specifies a public free scanner: a URL form that checks the home page plus two linked
pages at one viewport and shows counts per failure type with three examples each. The scan must
run through the same request-forgery guard and `robots.txt` handling as paid scans (PLAN §11,
§16, §18).

On `main` (commit `d201f2b`) nothing accepts an anonymous scan. `packages/engine` runs
`scan.page@1` jobs for a tenant's verified site (`packages/engine/src/worker.ts` rejects a job
without a tenant: `tenant_missing`), `crates/api` has no free-scan route, and the contracts
package has no free-scan operation. Adding one means a queue, a payload contract, an api route
and a decision about an anonymous tenant, all in `crates/` and `packages/engine`, which the site
lane does not own.

## Decision

- The web side talks to a typed seam, `FreeScanner` in
  `apps/web/src/lib/server/scanner/client.ts`: `scan({ origin, domain })` returns
  `not-connected`, `refused` (robots, bot challenge, unreachable) or `complete` with a
  `FreeScanResult` (checks passed and run, failure groups with at most three examples each, the
  pages checked).
- The binding on `main` is `notConnectedScanner`. Every scan request that passes validation, the
  Turnstile check and the caps gets the state "The scanner is not connected yet", with plain
  wording: nothing was scanned. A request that ends there gives back its reserved quota, so a
  visitor never loses a scan to a feature that is not there.
- `FREE_SCANNER_BACKEND` selects the binding: `not-connected` (default) or `fixture`. The fixture
  returns a fixed, visibly labelled sample ("Test data. This is a fixed sample ... not a real
  scan.") and exists so the end-to-end tests can exercise the result page, the cache and the
  caps. No other value is accepted, and the setting is operator-controlled.
- `createFreeScanService` takes the scanner, the challenge verifier and a clock as parameters, so
  every branch is unit-tested with fakes (`service.test.ts`).
- Not built here, for the same reason: the full report by email with double opt-in (PLAN §16),
  which needs the email package's sending boundary and a consent store.

## Consequences

- The site, pricing page and scanner form ship and pass axe now. The scanner is honest about
  being unconnected instead of faking results.
- Connecting it is a bounded follow-up: an engine queue for public scans (anonymous tenant,
  free-scanner limits enforced again server-side, `robots.txt` for the Rampsmith user agent, the
  egress guard), an api route, and an implementation of `FreeScanner` over it. The page, the
  caps and the cache do not change.
- LAUNCH.md section E gets a row for the free scanner end to end.

## Rejected alternatives

- Calling `scan.page` with a borrowed tenant: breaks tenant isolation (CLAUDE.md, row-level
  security) and the "verified sites only" rule.
- Returning sample results in production while the engine is missing: it would show visitors
  failures that were never found. The fixture is for tests and labelled as such.
- Hiding the scanner page until the engine exists: the site, the Turnstile wiring and the
  limits are real work that can be tested now.
