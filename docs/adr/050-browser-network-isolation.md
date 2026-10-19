# ADR-050: Network isolation of the scanning browser

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-025 (egress guard), PLAN §18
- Fixes: R0 security audit M1 and L2 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

PLAN §18 says Chromium sends all traffic through `egress`. The R0 audit measured two ways that
was not true of a hostile page:

- **M1, WebRTC.** `RTCPeerConnection` sends UDP (STUN, TURN, ICE connectivity checks, DTLS) from
  the browser process, not through the HTTP proxy. A scanned page could therefore send UDP to any
  address the engine's network can reach: loopback, the private network and cloud metadata
  ranges, none of which egress's address policy ever saw. The audit counted 4 packets reaching a
  loopback listener with the production settings.
- **L2, loopback.** Chromium never sends `localhost`, `127.0.0.0/8` and `::1` through a proxy
  unless the proxy bypass list holds the rule `<-loopback>`, which "has the effect of
  subtracting the implicit rules" ([Chromium, Proxy support](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)).
  Playwright 1.64.1 adds the rule itself, unless the environment variable
  `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set (`shouldProxyLoopback` in
  `playwright-core/lib/coreBundle.js`). The engine relied on that default, and a comment in
  `scan-page.ts` said the opposite ("Chromium skips the proxy for loopback unless told
  otherwise"). Setting the variable by mistake would have let a page reach the engine's own
  loopback services.

## Decision

1. **WebRTC policy.** Every browser the engine starts gets
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. The switch is Chromium's
   (`force-webrtc-ip-handling-policy`, with the value `disable_non_proxied_udp` defined in
   Blink's `webrtc_ip_handling_policy.cc`; both strings are in the Chromium 153.0.8010.0 binary
   the tests run). With it, WebRTC may use only a path that goes through the configured proxy,
   and egress, an HTTP proxy that tunnels `CONNECT` to port 443 only, carries no UDP.
2. **One module launches the browser.** `packages/engine/src/browser.ts` owns the launch
   options (`launchOptions`, `launchBrowser`) and the per-context proxy settings
   (`contextProxy`). `main.ts`, `self-check.ts` and the browser tests all use it, so the tests
   exercise the production settings and cannot drift from them.
3. **Loopback is named.** The launch proxy (`per-context`) and every context proxy carry
   `bypass: '<-loopback>'`. The engine refuses to start (`launchBrowser`) and refuses to open a
   proxied context (`scanPage`) when `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is
   defined at all, even empty. The test-only `loopback` option of `scanPage` and of the worker's
   `egress` settings is removed: loopback always goes through egress, which refuses it unless a
   test opens `127.0.0.0/8` with `EGRESS_ALLOWED_CIDRS` (ADR-025, point 6).
4. **Deploy-time network restriction (not enforceable on Railway today).** The intended
   production rule is that the `engine` service may open connections only to `egress` and
   PostgreSQL on the project's private network (plus, while telemetry is configured, the
   OpenTelemetry collector). Checked on Railway's documentation on 19 October 2026:
   - [Private networking](https://docs.railway.com/networking/private-networking.md) gives each
     service a `SERVICE_NAME.railway.internal` name over encrypted WireGuard tunnels, "isolated
     at the project and environment level" ([how it works](https://docs.railway.com/networking/private-networking/how-it-works.md)).
     It lets services reach each other; it does not stop a service reaching the internet or its
     neighbours.
   - [Networking](https://docs.railway.com/networking.md) lists private networking, outbound
     networking, static outbound IPs and public networking, and no egress filter, firewall or
     network policy. [Outbound networking](https://docs.railway.com/networking/outbound-networking.md)
     describes SMTP being disabled on lower plans and outbound IPv6 being off by default, not a
     way to restrict destinations. [Static outbound IPs](https://docs.railway.com/cli/outbound-network)
     fix the source address only.
   - [Guardrails](https://docs.railway.com/enterprise/guardrails.md) limit generated domains,
     public TCP proxies and deployment sources, and no outbound traffic.

   So the restriction cannot be written as configuration today, and this ADR does not claim it.
   What the code does instead is the layered control above: all of the page's HTTP traffic and
   its WebRTC fall back to egress, whose address policy is tested, and the engine holds no
   secret beyond its database role (ADR-052) and the egress token secret.

## Consequences

- A hostile page cannot send UDP, and cannot reach loopback, without egress seeing it. A browser
  escape (a renderer exploit chained with a sandbox escape) is a different threat: it would run
  as `pwuser` in the engine container with whatever network that container has. That residual
  risk is what the deploy-time rule in point 4 would close.
- Anything that needs the open internet (R2 uploads, the Claude API, SES) must not run in the
  process that holds Chromium once the rule can be enforced. Recommendation to the architect:
  when the engine gains those queues, deploy them as a second service from the same image
  (`engine-jobs`), and keep the scanning service (`engine`) to `scan.page` only.
- Pages that depend on WebRTC (live chat widgets on storefronts) still load; their media
  connections cannot be established and they fall back to TCP through the proxy or fail. Axe
  does not test them.
- Scans no longer start if someone sets Playwright's override switch in the environment; the
  error names the variable.

## What stays for the founder

- Ask Railway (founder account, support or the community) whether an outbound policy exists for
  the plan in use, and write the answer into LAUNCH.md section E. If it does not, decide between
  accepting the residual risk above for launch and hosting the `engine` service where egress can
  be filtered (a VM with a firewall, ADR-010's crossover target). Neither is a code change.

## Rejected alternatives

- Blocking WebRTC in the page (an init script that deletes `RTCPeerConnection`): changes what
  the page can do, can be bypassed (iframes, workers), and leaves the network open. The browser
  switch holds below the page.
- `--disable-features=WebRtcHideLocalIpsWithMdns` or `--force-webrtc-ip-handling-policy=default_public_interface_only`:
  they limit which local addresses leak, not whether UDP is sent.
- Leaving loopback to Playwright's default: one environment variable turns it off.

## Plan correction

PLAN §18, row "Server-side request forgery through scanned URLs", adds: "WebRTC is held to the
proxy with Chromium's `disable_non_proxied_udp` policy and loopback is proxied by an explicit
bypass rule (ADR-050). Restricting the engine's own network to `egress` and PostgreSQL is not
available on Railway today and is tracked as a launch input." PLAN §22's `engine` row has
"reachable only by `engine`" for `egress`; add "and the engine cannot be restricted to it on
Railway today (ADR-050)".
