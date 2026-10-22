# ADR-262: The free scanner's caps and cache live in the web process

- Status: Accepted
- Date: 2026-10-22

## Context

PLAN §16 sets the free scanner's limits: 3 scans per IP and 1 per domain per day, results cached
for 24 hours per domain, results never public. Nothing in the data layer exists for anonymous
visitors, and storing visitor IP addresses has a retention question the privacy draft leaves
open (`[RATE-LIMIT IP RETENTION]`).

## Decision

- `WindowLimiter` and `ResultCache` (`apps/web/src/lib/server/scanner/limits.ts`) hold the caps
  and the cache in process memory, bounded (50,000 keys per limiter, 2,000 cached results; the
  least recently used key leaves first). Nothing about a visitor is written to disk, a database
  or a log, which keeps the retention at "until the process restarts or 24 hours pass".
- Order of checks (`service.ts`): address, then the IP cap (read only), then Turnstile, then the
  cache, then a reservation of both caps before the scanner is called. A reservation is given
  back when no scan ran (not connected, refused, failed), so only real scans cost quota.
  Reserving before the call also stops concurrent requests from passing the same check.
- A cached result needs no scan and costs no quota; the cache is read only after the bot check
  passes, so it cannot be probed anonymously.
- The domain key is the host without a leading `www.`. A registrable-domain key needs the Public
  Suffix List, which is not a dependency of this app; the engine applies the real rule when it
  connects (ADR-260). Hostname-level keys can only be looser than the intended rule for
  sibling subdomains, which is the safe direction for the visitor and the scanned site alike.
- The visitor's address comes from SvelteKit's `getClientAddress()`. Behind a proxy that
  needs `ADDRESS_HEADER` (and `XFF_DEPTH`) set for adapter-node; this is a deployment variable
  to set with the Railway service definition, and without it every visitor shares the proxy's
  address and hits the cap together (a safe failure). The form post also needs SvelteKit to
  know its own origin (`ORIGIN`, or `PROTOCOL_HEADER` and `HOST_HEADER`), or its origin check
  answers 403; the end-to-end servers set `PROTOCOL_HEADER=x-forwarded-proto`, as the
  dashboard's do.
- `parsePublicUrl` is a syntactic guard only: http and https, no credentials, default ports,
  no IP address in any spelling, a dotted public-looking name, no reserved suffix. It reduces the
  address to the home page. The request-forgery guard with DNS resolution stays in egress.

## Consequences

- Correct while the web service runs one instance. A second instance doubles every cap and
  splits the cache; scaling out needs a shared store first (PostgreSQL, or Redis if adopted).
- A restart resets the caps. The scanner is not connected yet, so the abuse surface is the
  Turnstile endpoint, which is bounded by the per-IP check that runs before it.

## Rejected alternatives

- A database table for counters: a new tenant-less table and a retention policy for IPs, before
  the privacy draft decides the period.
- Trusting `X-Forwarded-For` blindly: any client could pick its own address and escape the cap.
