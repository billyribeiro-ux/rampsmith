# ADR-071: Password-protected storefronts and challenges

- Status: Accepted
- Date: 2026-10-22
- Source: R1 lane B; extends ADR-027

## Context

A development store is closed behind a storefront password. The engine has no key to unseal `sites.storefront_password_ct` (ADR-021, ADR-035).

## Decision

- `scan.page@2` detects the password page, and unlocks it only with a password the deployment supplies for this scan through `EngineDeps.storefrontPassword`. Production wiring supplies none; the page is then recorded as blocked with `blocked_reason = 'storefront_password'` and never stored. The password is never logged or persisted by the engine.
- A bot challenge is detected and recorded as blocked; it is never solved or evaded (ADR-027).
- Only verified sites are scanned, and only on hosts of the site's `base_url` and the shop's primary domain.

## Consequences

`ctl` can pass a password to a scan by serving the engine a hook, or leave the store reported as blocked in the coverage disclosure. This is a LAUNCH.md section E row until it runs against a live development store.
