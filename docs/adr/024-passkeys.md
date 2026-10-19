# ADR-024: Passkeys and sessions for the standalone dashboard

- Status: Accepted
- Date: 2026-10-17

## Context

R0 step 8 includes "the standalone shell with passkeys". PLAN §16 sets passkeys through
`webauthn-rs`, an emailed one-time link as fallback, and opaque sessions in an `HttpOnly`,
`Secure`, `SameSite=Lax` cookie stored hashed, with 7-day idle and 30-day absolute expiry.
`webauthn-rs` 0.5.5 (crates.io, 30 April 2026, MPL-2.0, MSRV 1.88) depends on
`webauthn-rs-core`, which uses OpenSSL for signature and attestation verification; this
workspace banned `openssl` so that TLS stays on rustls (ADR-016). Pure-Rust alternatives were
checked: `webauthn-rp` 0.3.0 (last release April 2025, little adoption) is too thin a base for
an authentication path; writing a WebAuthn verifier ourselves is the riskier option.

## Decision

1. **Library.** `webauthn-rs` 0.5.5 with `danger-allow-state-serialisation` (ceremony state is
   stored server-side in PostgreSQL, so any `api` instance can finish a ceremony) and
   `conditional-ui` (discoverable sign-in). `openssl` and `openssl-sys` are allowed only as
   dependencies of `webauthn-rs-core` (cargo-deny `wrappers`); TLS remains rustls everywhere.
   MPL-2.0 joins the license allowlist: the crates are used unmodified, which triggers no
   source-disclosure duty. The images link the system OpenSSL 3, kept current by
   `apt-get upgrade` and scanned by grype.
2. **Ceremonies.** Registration takes an email and display name, creates no user until the
   passkey verifies, and requires user verification. Sign-in is discoverable: the server sends
   no credential list and learns the user from the credential's user handle, so sign-in reveals
   nothing about which emails have accounts. Ceremony state lives in `webauthn_ceremonies`,
   is consumed on first use, and expires after five minutes. Counter regressions are rejected
   by `webauthn-rs`.
3. **Identity is not tenant data.** `users`, `passkeys`, `webauthn_ceremonies` and
   `web_sessions` carry no `tenant_id` (a user will join several organizations through
   memberships in R2). They are reached only through `Db::identity()`, an `IdentityTx` that
   only the identity repository accepts; the worker role has no grants on them.
4. **Sessions.** A sign-in creates a session with a 256-bit random token; only its SHA-256 is
   stored. `api` returns the token once; `web` keeps it in the `rs_session` cookie (`HttpOnly`,
   `Secure`, `SameSite=Lax`, path `/`) and forwards it to `api` in `Authorization: Session …`.
   Each use extends the idle expiry to at most the absolute one. Signing out deletes the row.
5. **Relying party.** `WEBAUTHN_RP_ID` (the registrable domain, such as `app.rampsmith.com`) and
   `WEBAUTHN_RP_ORIGIN` (the dashboard origin) are required `api` configuration.
6. **Not yet:** the emailed fallback link needs an email provider account (Amazon SES, PLAN §6),
   and email addresses stay unverified until it exists; organizations and memberships arrive
   with the agency view (R2).

## Consequences

- One C dependency (OpenSSL) enters the control plane, confined to WebAuthn verification.
- Registration does reveal whether an email is taken ("sign in instead"), the usual trade-off
  until email verification exists.
- Browser tests drive real ceremonies with Chromium's virtual authenticator against the real
  `api` and database, and Rust tests use `webauthn-authenticator-rs`'s software passkey.

## Rejected alternatives

- `@simplewebauthn/server` in `web`: puts authentication logic in the backend-for-frontend,
  against ADR-005.
- Email-first sign-in with an allow list: leaks which emails have accounts.
- Storing ceremony state in a signed cookie: replayable within its lifetime unless tracked
  server-side anyway.
