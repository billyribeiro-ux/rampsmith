# ADR-264: Health listeners for ctl, egress and engine

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 release gaps (`crates/ctl`, `crates/egress`, `packages/engine`, `infra/railway/tests`)
- Refines: ADR-182 (every service answers `GET /healthz` on `PORT`), ADR-185 (strict smoke tests on `main`)

## Context

The release run on `main` at 44ca4a7
([run 39873911672](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39873911672)) failed
`image_smoke.sh` in strict mode for `ctl` ("no 200 from GET /healthz on PORT 8080 within 90 s")
and `egress` (same, port 8888). `railway.py` gives each of `web`, `ctl`, `engine`, `egress` and
`collector` the health check `/healthz` on `PORT`; the three services above served nothing
there: `ctl` and `engine` are workers with no HTTP server at all, and `egress` answered every
request as a proxy request (407).

Railway's [health check documentation](https://raw.githubusercontent.com/railwayapp/docs/main/content/docs/deployments/healthchecks.md)
(read 22 Oct 2026) says: the check is optional ("if a healthcheck endpoint is configured");
Railway queries the path until any `2xx` and only then makes the new deployment active and the
previous one inactive; it "does not monitor the healthcheck endpoint after the deployment has
gone live"; the port is `PORT`; the request comes from the host name `healthcheck.railway.app`
(a service that filters on `Host` must accept it); the default timeout is 300 seconds.

## Decision

Keep the health check for all three and give each a listener, instead of removing the check
from the worker services. The documentation gives two reasons: without a check, a deployment that
starts and then crashes still replaces the working one (the check is what makes the cut-over
zero-downtime), and `ctl` holds the leader lease and drains for 120 seconds, so a bad `ctl`
must not take over silently. Removing the check would also mean weakening the strict smoke test,
which CLAUDE.md forbids.

1. **ctl** (`crates/ctl/src/health.rs`): a hand-written listener on `BIND_ADDR`, else
   `[::]:$PORT`, else `[::]:8080`. It answers `GET /healthz` (HTTP/1.0 or 1.1, request line
   exactly) with 200 and the body `ok`, and every other request with 404 and no body. No other
   route, no data, no database access, no `Host` check. It is bound before the database role
   check, which can wait for the database, so a database outage does not fail the deploy of the
   process that waits for it. Connections are capped at 32 and a client has 5 seconds to send
   its request line. It stops with the workers on SIGTERM.
2. **egress** (`crates/egress/src/proxy.rs`, `is_health_check`): the proxy answers 200 `ok` for a
   `GET` whose URI is in origin form (no scheme, no authority) and whose path is exactly
   `/healthz` with no query. A proxy request always names its destination (a `CONNECT`
   authority or an absolute `http://` URI), so this shape can never be a proxy target, and the
   handler returns before any token, resolver or connection is touched. Everything else, including
   `/healthz/`, `/healthz?x`, `POST /healthz` and `GET http://host/healthz`, takes the normal
   path and needs a scan token. The test
   `the_health_check_answers_for_the_process_and_is_never_proxied` covers each of these, with a
   `Host` header naming an allowed upstream (the upstream answers `path=...`, the health check
   `ok`), and the image smoke test (`infra/smoke/egress.sh`) repeats the 200/407 split against
   the real image. Scan tokens and the address policy are untouched.
3. **engine** (`packages/engine/src/health.ts`): the same single route on `PORT` (default
   8080), started by `main.ts` after the database role check and the browser launch (ADR-265),
   so an engine that cannot scan never passes the deploy check.
4. `image_smoke.sh` now puts the last eight log lines into its error annotation, because CI logs
   are not always readable and annotations are.

## Consequences

- Each listener is liveness for the process, as Railway uses the check (deploy time only). It
  says nothing about queue progress; `ctl`'s leader and the queue metrics (ADR-184) do.
- `railway.py` and `service_spec.py` do not change; `/readyz` stays the api's alone.
- `ctl` now needs the `net` and `io-util` tokio features; no new crates.

## Rejected alternatives

- Dropping the health check on `ctl`, `engine` and `egress`: loses the cut-over gate (above).
- Serving `/healthz` from egress on a second port: Railway checks `PORT` only, and a second
  listener is more surface than one exact-match branch.
- A `hyper` server in `ctl`: a second HTTP stack for one fixed response.
