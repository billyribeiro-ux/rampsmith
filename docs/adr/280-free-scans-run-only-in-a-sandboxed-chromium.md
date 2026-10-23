# ADR-280: Free scans run only in a Chromium that has its own sandbox

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-265 (the fallback no longer reaches the free scanner), ADR-267 (the api checks that
  a sandboxed engine is serving before it accepts a scan)
- Source: audit of the R1 integration, finding H1 (`docs/evidence/r1-integration-audit.md`)

## Context

ADR-265 lets the engine start Chromium without its sandbox on a Railway host that refuses it,
and accepted that as a residual risk because every page the engine loads is a merchant's own
store. ADR-267 then added `free_scan.run`, which loads whatever site an anonymous visitor types
into the form. The same shared browser served both, and the same process holds the worker
`DATABASE_URL`, `EGRESS_TOKEN_SECRET`, `RAMPSMITH_SCAN_SECRET_KEYS`, `ANTHROPIC_API_KEY` and the
R2 evidence keys (`infra/railway/railway.py`, the `engine` service). With the sandbox off, one
renderer exploit served by a stranger's page is code execution as `pwuser` next to all of them:
the exposure ADR-265 accepted for merchants' stores had become one that anyone can trigger.

## Decision (the architect's)

1. **The engine registers the `free_scan.run` queue only when its Chromium's sandbox is `on`.**
   `queuesFor(sandbox)` (`packages/engine/src/queues.ts`) is the single place that decides; `main.ts`
   starts one worker per queue it returns. With the sandbox `off` the engine serves the six
   merchant queues and says `engine: not serving free scans: chromium runs without its sandbox`.
2. **The engine tells the api when it is serving free scans.** While it serves the queue it writes
   its worker id and the time to `free_scan_engines` every 15 seconds
   (`packages/engine/src/free-scan-beat.ts`) and removes the row on a clean stop. The function
   `free_scan_engine_available()` is true while a row is under 45 seconds old (three missed
   beats). A killed engine, a stuck event loop and a database it cannot reach all end the same way:
   the rows age out.
3. **The api answers 503 "free scanner unavailable" while the function is false**, as the first
   thing `POST /v1/free-scans` does after authentication: no Turnstile call, no budget spent,
   no row, no job. The body carries `errors: [{ field: "scanner", message: "unavailable" }]`; the
   web server maps that to its existing `not-connected` outcome, so the page says the scanner is
   not connected and that the attempt did not count against the visitor's scans.
4. **A browser that disconnects ends the engine** (audit L6): `exitWhenBrowserLost` exits with
   code 1 and `/healthz` answers 503 first, so the heartbeat cannot outlive the sandbox it vouches
   for.

Why a heartbeat row and not queue-claim recency: a quiet scanner claims nothing for hours, which
looks the same as a dead one. The row distinguishes "serving and idle" from "not serving" and
needs no traffic. Why not a flag in a setting: a setting survives the engine that wrote it.

## Consequences

- If Railway's host refuses the sandbox (ADR-265 reports that some do), the free scanner is
  unavailable until the engine runs on a host that allows it, or the free scanner moves to its own
  service (below). Merchants are unaffected: their scans keep running, as ADR-265 decided.
- `ENGINE_CHROMIUM_SANDBOX=required` still exists; with `auto` the engine now degrades to "no free
  scans" rather than "free scans in an unsandboxed browser".
- Whether Railway's hosts give the sandbox is measured on the first staging deploy: LAUNCH.md E,
  "Chromium's sandbox on Railway's hosts".

## Recommendation for the founder (not built: it costs money)

Run the free scanner as a **second Railway service from the engine image** that holds only what
a free scan needs: a database login restricted to `free_scans` and the queue (no tenant data, no
`RAMPSMITH_SCAN_SECRET_KEYS`, no `ANTHROPIC_API_KEY`, no R2 keys), and `EGRESS_TOKEN_SECRET`.
Then even an unsandboxed browser, or a sandbox escape, would reach nothing of a merchant's.
It is one more service to pay for and deploy; `queuesFor` and the heartbeat already make the split
a configuration change (a second queue list per service). ADR-050 made the same recommendation for
the AI queue.

## Rejected alternatives

- Keep serving free scans unsandboxed and rely on egress (ADR-050): Railway has no outbound filter,
  and the process holds secrets worth more than the scan.
- A separate service now: spends money the founder has not approved (CLAUDE.md, Founder boundary).
- A "sandbox" boolean in a table: a stale flag outlives a crashed engine.
