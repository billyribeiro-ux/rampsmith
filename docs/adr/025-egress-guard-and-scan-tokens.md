# ADR-025: The egress guard, scan tokens and the engine skeleton

- Status: Accepted
- Date: 2026-10-17

## Context

R0 step 9 is "`egress` and an `engine` skeleton that scans one page through it". PLAN §18 sets
the guard's job: Chromium reaches storefronts only through `egress`, which resolves names
itself, refuses non-public addresses (loopback, private, link-local and cloud metadata, CGNAT,
unique-local, IPv4-mapped), re-checks every redirect and enforces a per-page budget. PLAN §11
sets the engine: Playwright 1.64.1 and axe-core 4.14.0 with the WCAG 2.2 AA tag set, findings
fingerprinted by rule, normalized selector and template origin, and challenges recorded, never
evaded (PLAN §3, §27).

Two things the plan left open: how egress knows which hosts a given scan may reach, and which
resolver it uses (§8 lists `hickory-resolver` 0.26.3).

## Decision

1. **Forward proxy.** `egress` is a hyper 1.12 HTTP/1.1 forward proxy. It serves `CONNECT` to
   port 443 (TLS stays end to end between Chromium and the store) and absolute-form `http://`
   requests to port 80, which it forwards without the proxy credentials or hop-by-hop headers
   (RFC 9110 §7.6.1). Any other port, method or target form is refused.
2. **Address policy.** Every address a name resolves to is checked against a fixed block list
   (IPv4 and IPv6 special-purpose registries, plus IPv4 embedded in IPv4-mapped and NAT64
   addresses). If any address in the answer is refused, the whole answer is refused, and egress
   dials only the addresses it checked, so a second resolution cannot rebind. A redirect to
   another host is a new connection and passes the same checks. IP literals are hosts like any
   other and must be on the token's list.
3. **Scan tokens.** The engine signs a short-lived token per page job and passes it as the
   proxy's Basic password (Playwright's per-context proxy). Format:
   `base64url(json) "." base64url(HMAC-SHA256(secret, "rampsmith-egress-v1." + body))`, payload
   `{v, scan, hosts, budget, exp}`. `hosts` holds exact names or `.suffix` entries (the site's
   host plus Shopify's CDN hosts); `budget` caps the connections the token may open; `exp` is two
   minutes out. Rust and TypeScript share test vectors in
   `crates/egress/testdata/tokens.json`. The secret is `EGRESS_TOKEN_SECRET` in both services,
   at least 32 bytes.
4. **Budget unit.** egress cannot see requests inside a TLS tunnel, so the budget counts
   connections (tunnels plus forwarded requests) per token. Exhaustion answers 429.
5. **Resolver.** The operating system's resolver (`tokio::net::lookup_host`) behind a
   `Resolve` trait, instead of `hickory-resolver`. The protection comes from checking every
   answer and dialling only checked addresses, not from the resolver; the system resolver
   follows the platform's DNS configuration and avoids hickory's dependency tree
   (`hickory-proto`, `hickory-net`, `moka`, `rand`). The trait lets a pinned public resolver
   replace it later without touching the policy.
6. **Test-only settings.** `EGRESS_ALLOWED_CIDRS` opens listed ranges (tests open
   `127.0.0.0/8` to reach a local fixture store) and logs a warning at start;
   `EGRESS_TUNNEL_PORTS` and `EGRESS_HTTP_PORTS` replace 443 and 80. Production sets none of
   them.
7. **Engine skeleton.** `packages/engine` runs the `scan.page@1` job from the TypeScript queue:
   it re-checks that the site is verified and the URL is on the site, opens a fresh browser
   context through egress, runs axe with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`, detects
   bot challenges (Cloudflare, CAPTCHA, HTTP 429) and records them as blocked without retrying
   or evading them, scrubs and truncates HTML excerpts to 512 characters, and records
   `scan_pages` and `findings` in one tenant transaction. `scan_pages` is unique on
   `(scan_id, url, page_state)`, so a job that runs again after a crash records nothing twice.

## Consequences

- Chromium can reach only the hosts a signed token names, at public addresses, within a
  connection budget; a forged, expired or foreign token gets 407.
- The engine and egress share one secret, so rotating it needs both services redeployed
  together; the two-minute expiry keeps the overlap short.
- The browser tests run the real egress binary (`mise run build:egress`), so the guard is part
  of every engine test that loads a page.
- A per-request budget inside tunnels, if needed, belongs in the engine (Playwright request
  counting), not in egress.

## Rejected alternatives

- Allow-listing hosts in egress configuration: a scan's hosts change per site; a token binds
  them to one job.
- `hickory-resolver`: more dependencies for no gain in the guarantee (point 5).
- Blocking in the browser only (Playwright request interception): a compromised or confused
  renderer could still open sockets; the network boundary must be outside the browser.
