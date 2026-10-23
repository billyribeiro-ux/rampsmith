# ADR-281: The web service reads the visitor's address from `X-Real-IP`

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-042 (item 2: the header and the depth), ADR-262, ADR-267
- Source: audit of the R1 integration, finding M1

## Context

The `web` service in `infra/railway/railway.py` set neither `ADDRESS_HEADER` nor `XFF_DEPTH`.
adapter-node's `getClientAddress()` is then the TCP peer, which behind Railway's edge is the
edge. Two consequences: every visitor shared one per-address free-scan budget (the first three
scans of the day used it up for everyone, ADR-267), and the `remoteip` sent to Turnstile was the
edge's. The same address keys the media route's guard (ADR-099). ADR-042 asked for
`ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1`, "Railway documents that its edge sets the
real address".

## Evidence

Railway's documentation, [Specs & Limits](https://raw.githubusercontent.com/railwayapp/docs/main/content/docs/networking/public-networking/specs-and-limits.md)
(fetched 22 Oct 2026), row "Request Headers":

> `X-Real-IP` for identifying client's remote IP. `X-Forwarded-Proto` always indicates `https`.
> `X-Forwarded-Host` for identifying the original host header. `X-Railway-Edge` … `X-Request-Start`
> … `X-Railway-Request-Id` …

`X-Forwarded-For` appears nowhere in the repository's `content/docs/networking/` pages (searched:
public networking, specs and limits, domains, private networking, proxy). So the documentation
**does not say** that the edge appends exactly one `X-Forwarded-For` hop, nor that it replaces a
caller's copy; it names `X-Real-IP` as the header that carries the client's address. Threads on
Railway's help station (their titles include "Does the edge strip client X-Forwarded-For? Two staff
answers contradict", "Edge/CDN layer leaking its own IP as client IP in X-Forwarded-For" and
"Which client-address headers does the Railway edge set, and are caller copies replaced?") show
the same gap; they could not be opened from this environment (`robots.txt`), so they are cited
only as the existence of the question, not as evidence of an answer.

## Decision

1. **`web` sets `ADDRESS_HEADER=X-Real-IP`** (`railway.py`, `_web`), the one header Railway
   documents for the client's address. adapter-node then takes the whole header value as the
   address. No `XFF_DEPTH`: it applies only to `X-Forwarded-For`, which Railway does not
   document. A request without the header makes `getClientAddress()` throw; the scan form then
   answers 500 rather than sharing a budget, which is the safe failure.
2. **Whether the edge replaces a caller's `X-Real-IP` is not documented**, so it is a staging
   check, not an assumption: LAUNCH.md E, "Visitor address behind Railway's edge". If a forged
   `X-Real-IP` is honoured, the per-address limit can be evaded by rotating the header; the
   per-domain limit (1 per day) and the in-flight ceiling (40) still bound the cost, and the fix
   is to put Cloudflare's proxy in front (its `CF-Connecting-IP` is documented) and read that.
3. **The cache is read before the address budget** (`crates/api/src/free_scan.rs`): a complete
   scan of the domain from the last day answers first, with no Cloudflare call and no place spent,
   so a visitor on an exhausted or shared address can still read what is already known.
4. ADR-042's statement that the web server must send the verified address as the last
   `X-Forwarded-For` entry stands for the api's own limiter (the web server sets that header
   itself); only the web server's view of the visitor changes here.

## Consequences

- The free scanner's per-address budget means a visitor, once the staging check passes.
- Local and end-to-end runs set no `ADDRESS_HEADER` and keep using the socket address.
- Test: `infra/railway/tests/test_railway.py::test_web_reads_the_visitor_address_from_the_edge_header`
  (only `web` has it, no depth), `crates/api/tests/free_scan.rs`
  (`a_cached_result_is_served_before_the_budget_and_before_cloudflare`).

## Rejected alternatives

- `X-Forwarded-For` with `XFF_DEPTH=1` (ADR-042's wording): rests on a hop count and a replacement
  rule Railway does not document; a wrong depth silently reads a client-supplied entry.
- The socket address: the edge's, for everyone.
