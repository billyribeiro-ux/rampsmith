# ADR-055: The dashboard session cookie carries the `__Host-` prefix, and dashboard pages are never cached

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-024 (passkeys, item 4 "Sessions"), PLAN §18
- Fixes: R0 security audit L8, the `web` half (the `api` half is in the Rust lane)

## Context

`web` kept the api's session token in a cookie named `rs_session` (`HttpOnly`, `SameSite=Lax`,
`Path=/`), `Secure` only when it believed the request used HTTPS (`url.protocol`). Two gaps:

- Without the `__Host-` prefix a browser lets any sibling subdomain, or any plain-HTTP page on the
  host, set a cookie of the same name. That is session fixation: the attacker plants a session
  token he knows and waits for the victim to register or sign in.
- Dashboard pages are server-rendered with the signed-in user's name and email, and their content
  depends on the cookie, yet they carried no cache header. A shared cache or the browser's
  back/forward cache could show them after sign-out.

## Decision

1. **The cookie is `__Host-rs_session`**, always `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
   with no `Domain` (`apps/web/src/lib/server/dashboard.ts`). The `secure` argument of
   `finishCeremony` is gone: the scheme `web` sees no longer decides. Production is always HTTPS
   behind Railway's proxy, so nothing changes there.
2. **`http://localhost` still works in Chromium.** A cookie marked `Secure` is accepted from
   `http://localhost` (a secure context) by Chromium, which the browser tests prove (below).
   `vite dev` and the e2e stack rely on that. Only Chromium was tested. Safari is reported not to
   accept `Secure` cookies over plain HTTP, even from localhost (not tested here), so a developer
   signing in to a local dashboard there would need a local HTTPS proxy. Nothing but a developer's
   machine is affected.
3. **Deleting the cookie repeats the attributes.** A `Set-Cookie` for a `__Host-` name that lacks
   `Secure` is ignored whole, deletions included, and SvelteKit's default for `Secure` is false on
   `http://localhost`. `clearSession` passes the same options as the cookie was set with, and the
   dashboard layout, which clears a cookie whose session ended, and `signOut` both use it. Without
   that, signing out on localhost deleted the session at the api but left the cookie in the
   browser (proved below).
4. **`cache-control: private, no-store`** on every response under `/dashboard`: pages, redirects,
   SvelteKit data requests and the JSON endpoints, in `securityHeaders` (`headers.ts`). It replaces
   a weaker value a route set. Other routes keep their own caching.
5. **No migration.** Nothing was released with `rs_session`; the old name is not read. A browser
   that holds it would sign in again.

## Tests

- `dashboard.test.ts` (12 tests): the name, `Secure`, `Path=/`, no `Domain` whatever the request
  scheme; `signOut` and `clearSession` delete with the same attributes, with and without a cookie.
- `headers.test.ts` (6 tests): `private, no-store` on `/dashboard` and below, over a weaker route
  value, and nothing on `/`, `/app`, `/dashboards` or assets. Removing the line fails two tests.
- `tests/dashboard.spec.ts`, real Chromium on `http://localhost:3996` and the real api:
  - after registering, the cookie is in the browser with `Secure`, `HttpOnly`, `Path=/`,
    `SameSite=Lax`, the `Set-Cookie` header carries no `Domain`, and the next request is signed in
    (so Chromium did accept and send it);
  - sign-out and the layout's clean-up of an ended session (the api ends it while the browser
    keeps the cookie) send a `Set-Cookie` with `Max-Age=0` and `Secure`, and the cookie leaves
    the browser; with `cookies.delete(name, { path: '/' })` both tests fail because the cookie
    stays;
  - `/dashboard`, `/dashboard/sign-in` and the redirect of a signed-out visitor are
    `private, no-store`.

## Consequences

- Revoking earlier sessions on sign-in and redacting the session token in `SessionCreated`'s
  `Debug` (the rest of L8) belong to `crates/api` and are not part of this change.
- ADR-024 item 4 still names `rs_session`; this ADR supersedes the name.

## Rejected alternatives

- `__Secure-` prefix: allows `Domain` and so a cookie shared with subdomains. Nothing needs that.
- Keep `Secure` conditional on the scheme: a `__Host-` cookie without `Secure` is dropped by
  every browser, so the e2e stack would fail to sign in.
- `Cache-Control` per page with `setHeaders`: easy to forget on the next route, and does not cover
  redirects or the JSON endpoints.
