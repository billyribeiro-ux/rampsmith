# ADR-282: Page scans and job attempts have deadlines the page cannot defeat

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-050 ("hard time limits"), PLAN §18 (page tokens live 120 seconds)
- Source: audit of the R1 integration, finding M2 and L8

## Context

A page scan's time limits were Playwright's navigation timeout and `settle`'s cap, and `settle`
is a `setTimeout` inside the page. A page that replaces `setTimeout`, or that busy-loops its main
thread after it has loaded, never lets `page.evaluate` return; `page.title()` and `page.content()`
have no timeout at all. The engine's queue worker heartbeats a running job for as long as its
handler has not returned, so such a page held a worker (concurrency 1 per queue) and its lease
forever. The free scanner made this reachable by anyone. Page tokens were signed for 300 seconds;
PLAN §18 says 120.

## Decision

1. **`scanPage` takes `deadlineMs`** (default 100 s, under the 120 s token) and races the whole
   scan against a timer in the engine process. At the deadline it closes the browser context (which
   ends the page's renderer however the page behaves) and throws `ScanDeadlineError`. The close
   is bounded (5 s) and is awaited once: Playwright's second `close()` returns before the first
   finishes. A context created after the deadline is closed at once.
2. **A free scan has an overall budget**: 120 s for robots.txt and every page together
   (`FREE_SCAN_BUDGET_MS`). Each page's deadline is the smaller of 45 s and what is left; a linked
   page is not started with under 10 s left, and the result covers the pages scanned so far.
3. **The queue worker takes `deadlineMs`** (`packages/queue/src/worker.ts`): at the deadline the
   handler's signal aborts, the heartbeat stops so the lease can expire, and the attempt fails as
   retryable (`job_deadline_exceeded`) even if the handler never returns. The engine sets it per
   queue (`deadlineMs()` in `queues.ts`): `scan.page` 150 s, `free_scan.run` budget plus 30 s,
   every other queue 600 s (`verify.scan` scans several pages). Each is above what its handler
   bounds itself to, so the handler's own failure handling (last-attempt bookkeeping) runs first.
4. **Page egress tokens live 120 s** (`PAGE_TOKEN_TTL_SECONDS`) for tenant pages and free scans.

## Consequences

- A hostile page costs the engine at most one deadline; the browser stays usable for the next job.
- A genuinely slow multi-state page scan that needs more than 100 s fails and retries.
- Tests: `packages/engine/test/deadline.e2e.ts` (real Chromium: a page that replaces its timer
  functions and one that busy-loops; the scan ends at the deadline, no context is left, the next
  scan works), `packages/queue/test/deadline.test.ts` (a handler that never returns),
  `packages/engine/test/free-scan.test.ts` (budget and token), `test/free-scan-gate.test.ts`.

## Rejected alternatives

- Fix `settle` to use the Node-side clock: `title()` and `content()` and the axe run can hang
  too; only a deadline outside the page covers all of them.
- Kill the browser at the deadline: it is shared by every job; the context is the unit.
