# ADR-286: The api checks the Turnstile action and hostname

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-267, ADR-260
- Source: audit of the R1 integration, finding L3

## Context

`siteverify` answers `success: true` for any token solved on a site key's allowed hostnames, for
any form. A token solved on another page that uses the same key (or on a hostname the key also
allows) would pass the free scanner's check.

## Decision

Checked against Cloudflare's documentation (`turnstile/get-started/server-side-validation` and
`widget-configurations`, in `cloudflare/cloudflare-docs` on 2026-10-22): the widget takes an
`action` (up to 32 characters of letters, digits, `_` and `-`), and `siteverify` returns the
`action` and the `hostname` the challenge was served on, and "validate the action and hostname when
specified".

- The widget is rendered with `action: 'free_scan'` (`apps/web/src/lib/site/turnstile-client.ts`).
- `FreeScans::verify` (`crates/api/src/free_scan.rs`) accepts a successful answer only if `action` is
  `free_scan` and, when `TURNSTILE_HOSTNAMES` is set, `hostname` is listed (case-insensitive). A
  mismatch is a visitor failure (`turnstile_token: failed`), logged without the token.
- `TURNSTILE_HOSTNAMES` is a comma-separated optional setting of the api. `infra/railway/railway.py`
  sets it on the api only, to `RAMPSMITH_APP_HOST` (the `web` service that serves `/scan`); with no
  host configured the variable is preserved. Left unset (a development setup) no hostname is
  checked; the action always is.
- The web server's own check (the standalone path, used without the api) refuses a wrong or
  missing action too (`apps/web/src/lib/server/scanner/turnstile.ts`).

## Consequences

- Cloudflare's dummy keys report the action `test` and the hostname `localhost`, so they no longer
  pass the api. Staging checks need a real widget for the staging host (LAUNCH.md section E).
- The test stand-in (`apps/web/tests/site-turnstile-fake.ts`) reports the action the widget was
  rendered with, as Cloudflare does.
- Tests: `crates/api/tests/free_scan.rs` (`a_token_from_another_form_or_another_site_is_refused`:
  another action, none, another hostname, none), `crates/api/src/config.rs`, `turnstile.test.ts`,
  `infra/railway/tests/test_railway.py`.
