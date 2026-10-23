# ADR-267: The free scanner scans through the api and the engine, and the limits live in the database

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-260 (the seam is connected), ADR-262 (the caps and the cache leave the web process)

## Context

ADR-260 coded the web side of PLAN §16's free scanner to a seam and shipped it "not connected":
`main` had no queue, no payload and no api route for an anonymous scan, and the engine refused
any job without a tenant. ADR-262 kept the caps and the cache in the web server's memory, which
is correct for one instance and a restart-resets-everything compromise, and which cannot protect
a scanner that spends browser time. R1's exit criteria need the scanner to scan.

## Decision

**Flow.** The visitor's form posts to the web server, which forwards it to the api; the api
checks and queues; the engine scans; the web server shows the result.

- `POST /v1/free-scans` and `GET /v1/free-scans/{id}` on the api, authenticated by a shared
  secret, `FREE_SCAN_SERVICE_TOKEN` (at least 32 characters, compared in constant time; the api
  refuses to start with a shorter one). Without the settings the routes answer 503.
- The api, not the web process, does everything that protects the scanner:
  1. it parses the address with the same rules as the web form (one public host; no address, port
     or credentials; no reserved suffix). The engine's egress guard still resolves DNS and pins
     the connection on every request;
  2. it reads the address's day budget, so a visitor over the cap costs no Cloudflare call;
  3. it verifies the Turnstile token server-side and fails closed. A Turnstile token works once,
     so the web server does not verify it in this mode;
  4. in one transaction, under advisory locks for the address and the domain, it returns a
     complete scan of the domain from the last 24 hours (the cache; no quota), or joins a scan
     of the domain that is still running, or enforces the caps and creates and enqueues the scan.
- **Limits** (PLAN §16): 3 scans per address and 1 per registrable domain per day (ADR-284), counted from the
  `free_scans` table, plus a ceiling of 40 scans queued or running at once (503 with
  `Retry-After`). A scan that failed on our side does not count; a refused one does, because it
  cost a robots.txt fetch and a page load. The limits hold across restarts and replicas.
- **Storage.** `free_scans` is not a tenant table: no merchant owns it and it holds no tenant
  data, so it has no `tenant_id` and no row-level security. It holds the domain, the origin, a
  status, a refusal reason, the result (a bounded JSON summary), and `ip_hash`: an HMAC-SHA256 of
  the visitor's address (the /64 for IPv6, the IPv4 for a mapped address) under a key derived
  from the Turnstile secret, which only the api holds (amended by ADR-287). The address is never stored; the hash allows equality counting only.
  Rows are deleted 24 hours after creation (`expires_at`, ADR-262's retention) by
  `free_scans_sweep()`, which `ctl`'s leader runs every 10 minutes; it first ends scans that
  neither finished nor failed within 10 minutes. The application role may insert and select; the
  worker role may select and update only `status`, `refusal`, `result`, `started_at` and
  `finished_at` (ADR-285); nothing else has a grant.
- **Queue.** `free_scan.run@1` with payload `{ free_scan_id }`. The application role cannot insert
  a job without a tenant (the job table's policy, ADR-003), and should not be able to: the api
  enqueues through `free_scan_enqueue(uuid)`, a `SECURITY DEFINER` function that creates only
  this job, for a scan that exists and is queued, idempotently.
- **Engine.** `free_scan.run` reads robots.txt through egress (RFC 9309: a 4xx means no rules; a
  5xx, 429 or no answer means disallowed; the agent token is `RampsmithBot`), refuses if the home
  page is disallowed, scans the home page at the desktop viewport in the default state, picks up
  to two linked pages (same site, no cart, account, checkout, search or asset paths, different
  kinds of page first, each checked against robots.txt) and scans them, then keeps a summary:
  checks passed of checks run over distinct rules, and failures by rule with a count and three
  examples of up to 240 characters. Page markup passes the engine's scrub (emails, form values,
  phone numbers) before it leaves the browser. A bot challenge, a closed store, a robots refusal
  or an unreachable site ends the scan as `refused`; challenges are never solved or evaded.
  Every connection goes through egress with a token naming the site, its `www` spelling, its
  subdomains and Shopify's CDN. A page whose styles come from another host is therefore checked
  with those styles missing; the result lists the pages it checked, and the live check in
  LAUNCH.md section E is where this is measured on real sites.
- **Web.** `FREE_SCANNER_BACKEND=api` hands the request to the api with the visitor's address
  and the Turnstile token and waits up to 45 seconds, polling. A scan that is still running
  gets a "Check again" action (`?/status`), which reads the scan by its id. The page is open when
  the Turnstile site key and the service token are set; the Turnstile secret lives with the api.
  `not-connected` and `fixture` remain for development and the end-to-end tests. In `api` mode
  the in-memory limiters and cache of ADR-262 are not used.

## Consequences

- The scanner can be scaled out and restarted without resetting its limits, and an abusive
  visitor meets the same limits whichever web replica answers.
- The privacy page's draft (`[RATE-LIMIT IP RETENTION]`) can say: a keyed hash of the address
  for 24 hours, no address. The text stays a draft that needs attorney review.
- The `api` service and `web` share one secret to generate (LAUNCH.md section C row 12) and the
  Turnstile secret moves from `web` to `api` in the Railway definition.
- Not built here (unchanged from ADR-260): the emailed full report with double opt-in.
- Live proof, against a real public site and the real Turnstile widget, is LAUNCH.md section E
  until it passes.

## Amendment (audit H1, ADR-280): only a sandboxed engine serves free scans

`free_scan.run` is registered only by an engine whose Chromium has its own sandbox (ADR-265's
fallback engines never serve it), and the api accepts `POST /v1/free-scans` only while such an
engine has beaten its heartbeat (`free_scan_engines`) in the last 45 seconds; otherwise it answers
503 "free scanner unavailable" before it spends a Turnstile call or a budget place, and the page
shows its not-connected state. A separate low-privilege free-scan service is recommended to the
founder (ADR-280); it is not built.

## Amendment (audit L1 to L5): what the api and the engine now check

- A public suffix is refused before the budget and before Cloudflare, and the day's per-domain
  count is keyed on the registrable domain (ADR-284).
- The engine's update grant is limited to the columns a run sets (ADR-285).
- A token must have been solved for the `free_scan` action on a listed hostname (ADR-286).
- Visitor addresses are hashed under a key derived from the Turnstile secret, not the service
  token (ADR-287); PLAN §19 lists the data. The privacy page stays a draft marked "attorney review
  required".
- Results are bounded (addresses at 2048 characters) and validated before they are stored (ADR-288).

## Rejected alternatives

- Keep the caps in web memory and only add the engine job: a second web replica or a restart
  would reset every cap while the scanner spends real browser time.
- An anonymous tenant: the isolation suite would then include a tenant that is shared by
  design, and every tenant policy would need an exception. A separate table without tenant data
  is the smaller surface.
- The web server writing to the database: it has no database access (ADR-005), and should not.
- Storing the raw address with a 24-hour life: a keyed hash serves the counting and cannot leak.
