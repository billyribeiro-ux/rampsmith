# ADR-046: A sign-in ends the user's earlier sessions, and session responses are not printable

- Status: Accepted
- Date: 2026-10-19
- Amends: ADR-024 (passkeys and dashboard sessions)
- Source: R0 security audit finding L8, Rust parts (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

ADR-024 gives each sign-in a new session and never ends the old ones: a user who signs in on
a new device, or signs in again because they suspect something is wrong, leaves every earlier
session alive until it idles out after 7 days or reaches its 30-day limit. A session token that
was copied (a laptop left unlocked, a malicious extension, a leaked log) therefore survives the
very action a person takes to get rid of it.

Separately, `SessionCreated`, the api's response to a successful sign-in, derives `Debug` and
holds the plaintext session token. A `{:?}` in a log line, an `#[instrument]` on a handler that
took it, or a test failure message would print a live credential.

The `__Host-` cookie prefix and `cache-control: private, no-store` parts of L8 are in `apps/web`
and belong to the TypeScript workstream.

## Decision

1. **A successful sign-in or registration ends all the user's earlier sessions**, in the same
   transaction that creates the new one (`Identity::create_session`, which both
   `finish_sign_in` and `finish_registration` use). A sign-in that fails verification ends
   nothing. Other users' sessions are untouched. Signing out still ends one session.
2. **Concurrent sign-ins of one user take turns.** `db::repo::identity::delete_sessions_of`
   first locks the user's row (`select ... for update`), then deletes their sessions. Two
   sign-ins at once then leave exactly one session: the second waits for the first to commit,
   then deletes the session it created. Deleting in one statement would not do: under `READ
   COMMITTED` its snapshot is taken before the lock wait ends.
3. **`SessionCreated` and `UserInfo` implement `Debug` by hand.** The token prints as
   `[redacted]`; the user prints as their id only (no email, no display name). A unit test
   formats both with `{:?}` and `{:#?}` and checks that neither the token, the email nor the
   name appears. `NewSession` in `identity` already holds the token as a `SecretString`, whose
   `Debug` is redacted.

## Consequences

- **One active session per user.** Signing in on a phone signs the laptop out. For a dashboard
  used a few minutes a week by one person that is acceptable, and it is what the audit asked
  for. If it proves annoying, the alternative is a cap (the newest five sessions) or an explicit
  "sign out everywhere" action; either is a small change to `delete_sessions_of`.
- A sign-in takes a row lock on the user for the length of its transaction, a few
  milliseconds. Different users never wait for each other.
- Registration calls the same function; a new account has no sessions, so it deletes nothing.

## Plan correction

PLAN §16 (Sign-in): add "A sign-in ends the user's other sessions (ADR-046)."

## Rejected alternatives

- **Keep the older sessions and add a "sign out everywhere" button.** Does not help the person
  who does not know which session is stolen, and puts the burden on the one who is already
  worried.
- **End the other sessions in a second request after the sign-in.** Leaves a window, and a
  failure between the two requests keeps the old sessions.
- **Redact with `#[serde(skip)]` or a `Secret` newtype around the String.** The response must be
  serialised with the token in it; a hand-written `Debug` keeps the type simple.
