# ADR-261: Cloudflare Turnstile protects the free scanner; the script and frame are allowed on that page only

- Status: Accepted
- Date: 2026-10-22

## Context

PLAN §16 puts Cloudflare Turnstile on the free scanner's form. LAUNCH.md section C, row 6 lists
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` as founder inputs, which builders never wait for
(section E rule: a substitute test now, a live test that skips with a notice, a row in E).

Checked in Cloudflare's documentation on 22 October 2026:

- Server-side validation (`developers.cloudflare.com/turnstile/get-started/server-side-validation`):
  `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` and `response`
  (and optionally `remoteip`, `idempotency_key`) as form data or JSON. The reply is JSON with
  `success` and `error-codes` (`missing-input-secret`, `invalid-input-secret`,
  `missing-input-response`, `invalid-input-response`, `bad-request`, `timeout-or-duplicate`,
  `internal-error`). A token is at most 2048 characters, valid for 300 seconds and usable once.
- Client-side rendering (`.../client-side-rendering`): the script is
  `https://challenges.cloudflare.com/turnstile/v0/api.js`, with `?render=explicit` for the
  explicit API (`turnstile.render`, `reset`, `remove`).
- Content Security Policy (`.../reference/content-security-policy`): `script-src` and
  `frame-src` must allow `https://challenges.cloudflare.com`; `connect-src` matters only for
  pre-clearance, which this site does not use.

The web app's policy is pinned for every page (ADR-054, audit M3) and the pin is tested.

## Decision

- `verifyTurnstile` (`apps/web/src/lib/server/scanner/turnstile.ts`) posts the secret, token and
  the visitor's address, with a 5-second timeout. A missing token is `missing`; an oversized or
  rejected token (`invalid-input-response`, `missing-input-response`, `timeout-or-duplicate`) is
  `invalid`, which the visitor can fix by running the check again; every other outcome (wrong
  secret, `bad-request`, `internal-error`, a network error, a non-JSON answer) is `unavailable`
  and fails closed. The token is verified on every attempt, because it works once.
- The page renders the widget explicitly (`turnstile-client.ts`) and calls `reset()` after every
  attempt to obtain a fresh token. Without JavaScript the form still posts and the server
  answers that the bot check did not pass, with a visible note that the check needs JavaScript.
- The scanner is closed (the form is not rendered, posts get 503) while either key is unset, so
  a missing configuration never leaves the form unprotected.
- The origin defaults to Cloudflare's and can be overridden with `TURNSTILE_ORIGIN`, which the
  end-to-end tests use to point at a local stand-in (`tests/site-turnstile-fake.ts`) that follows
  the documented behaviour, including single-use tokens.
- The policy for `/scan` and its sub-paths alone gets Turnstile's origin appended to `script-src`
  and a `frame-src` of that origin (`csp.ts`, a handle in `hooks.server.ts` that runs inside the
  security-headers handle, so `frame-ancestors` is still appended last). Every other page keeps
  the pinned policy, and `site-pages.spec.ts` asserts both.
- The script is the one exception to "no floating CDN scripts" (CLAUDE.md): Cloudflare serves
  `v0/api.js` from a path it updates in place and says not to self-host or copy it, so no exact
  version or hash exists to pin. It loads only on `/scan`, only from the allowed origin, and the
  rest of the page does not depend on it.
- The live check is `tests/site-turnstile-live.spec.ts`: with `TURNSTILE_SECRET_KEY` set it asks
  the real endpoint about a token that was never issued and expects `invalid` (which also proves
  the secret is accepted); without it the test skips with a notice naming LAUNCH.md row C6.

## Consequences

- Turnstile's origin is visible in the page's policy on one route only.
- Real widget behaviour (the iframe, the visible challenge) is verified at the first live run.
- The accessibility statement already says Cloudflare provides the widget and how to reach us if
  it blocks someone.

## Rejected alternatives

- Widening the global policy: it would weaken the embedded app and the dashboard for the sake of
  one page.
- Pinning an `api.js` hash or self-hosting it: Cloudflare advises against it, and a stale copy
  would stop verifying.
- Cloudflare's published dummy keys in CI: they test our code against a pretend service that
  still needs the real script. A local stand-in tests the same code without the network.
