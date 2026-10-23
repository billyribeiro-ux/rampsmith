# ADR-291: Connecting GitHub binds the installation to the signed-in store

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-127 (the manifest and the callback), integration audit finding L7

## Context

GitHub redirects the merchant's browser to the App's callback after the installation, carrying
`installation_id` and, because the manifest sets `request_oauth_on_install`, an authorization
`code`. That request has no Shopify session. Taking `installation_id` from it as given would let
anyone who knows or guesses an installation id attach it to their own store; and an
installation id alone does not say that the person who installed it may change the repository.

Read on 23 Oct 2026 in GitHub's documentation ("Identifying and authorizing users for GitHub Apps",
"Generating a user access token for a GitHub App", "List app installations accessible to the user
access token", "List repositories accessible to the user access token for an installation"): the
`code` is exchanged at `POST https://github.com/login/oauth/access_token` with the client id and
client secret and is single use; `GET /user/installations` lists the installations the user can
reach; `GET /user/installations/{id}/repositories` lists the repositories of one, each with the
user's `permissions`. The documentation does not promise that `state` set on the installation URL
is echoed to the callback of an OAuth-on-install redirect.

## Decision

1. The signed-in staff member presses "Connect GitHub". `api` stores the SHA-256 of a random
   256-bit `state`, bound to their tenant and site, valid for ten minutes and for one use
   (`github_install_states`). Plan gate: `github_pull_requests`.
2. The web server sets the state in an `HttpOnly`, `SameSite=Lax` cookie and sends the browser to
   `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new?state=<state>`.
3. The callback route of the web server forwards `code`, `installation_id`, the cookie's state and
   GitHub's echoed `state` (if any) to `POST /v1/github/callback`. When GitHub echoed one, it must
   equal the cookie's. The cookie plus the single-use, tenant-bound state is what binds the
   browser to the store when GitHub does not echo it (a live check, LAUNCH.md section E).
4. `api` consumes the state in one atomic statement (`app_github_consume_state`), before anything
   else is tried, so a failed attempt needs a new state. It exchanges the code, then requires that
   `GET /user/installations` lists the installation, reads the person's login, and lists
   `GET /user/installations/{id}/repositories` to record, per repository, whether the person could
   push (`user_can_push`). The user token is used inside the request and dropped; it is never
   stored, logged or put in a job payload.
5. Only a repository with `user_can_push` can be chosen as the theme repository.
6. `GITHUB_APP_CLIENT_SECRET` is held by `api` alone. The App's private key is held by `ctl`
   alone: `api` uses `GitHub::without_app`, which has no key and errors on any call that needs
   one. The secret is a Railway variable of the `api` service (`railway.py` and its test keep
   it there), a founder input (LAUNCH.md C row 4) and a name in `rsctl`'s list of founder secrets.
7. One GitHub installation belongs to one store (unique index over live installations), and a
   store has one installation. Linking an installation that belongs to another store, or linking
   a second one, is a 409.

## Consequences

An attacker with a Shopify session of their own store cannot attach another person's installation:
the GitHub user who authorised must be able to reach it. An attacker who can fix a victim's cookie
still needs the victim's state, which only the victim's session can create.

What the installer could push to is recorded when they connect. A repository added to the
installation later is listed by the sync but cannot be chosen until the merchant connects again;
the screen says so.

## The App Home screen and the two browser hops (R2 part 3)

- The "Code fixes" screen (`/app/code-fixes`) reads `GET /v1/shopify/code-fixes` through the BFF
  allow-list and shows one of: not available (flag off), the plan gate (the locked action and the
  plan that unlocks it, as other gated actions do), Connect GitHub, or the connected account with
  the repository choice, the request button, recent requests and pull requests. Its navigation
  link appears only when the channel is on.
- Connect GitHub asks the api for the state, then shows a real link, "Continue to GitHub", that
  opens `/github/connect?state=...` in a new tab. A link, not `window.open`: a popup opened after
  an async call is blocked, and the embedded frame cannot navigate to github.com itself. Focus
  moves to the link and the live region announces it.
- `/github/connect` checks the state's shape, sets it in an `HttpOnly`, `SameSite=Lax` cookie
  scoped to `/github` (ten minutes), and redirects to
  `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new?state=...`. An unset or malformed
  slug is refused at boot (web env) or at the hop, never sent to GitHub.
- `/github/callback` reads and deletes the cookie, passes `code`, `installation_id` and any echoed
  `state` to `POST /v1/github/callback`, and redirects to `/github/connected?result=<word>`. The
  address carries one of four words (connected, expired, refused, unavailable), never the code.
  Both hops answer `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`.
- `rsctl doctor --row 4` compares `GITHUB_APP_SLUG` with the `slug` that `GET /app` reports.

## Rejected alternatives

- Trust `installation_id` from the redirect: the confused-deputy hole above.
- Store the user token to re-check permissions later: a long-lived credential for no gain; the
  App's own installation token is what the pipeline uses.
- Put the App key in `api` so one process does everything: widens the blast radius of the
  internet-facing service.
