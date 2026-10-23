# ADR-287: Visitor addresses are hashed under a key only the api holds

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-267
- Source: audit of the R1 integration, finding L4

## Context

ADR-267 derived the HMAC key for `free_scans.ip_hash` from `FREE_SCAN_SERVICE_TOKEN`. The web
server holds that token. A compromised web server could hash any address it wanted and compare
the hash with the table, and the address space of IPv4 is small enough to enumerate. PLAN §19 also
had no row for the free scanner's data.

## Decision

- The key is derived (HMAC-SHA256 with the label `rampsmith/free-scan/address-hash/v2`) from
  `TURNSTILE_SECRET_KEY`, a secret that LAUNCH.md C row 6 already lists and that only the api holds
  (`infra/railway/railway.py` gives `web` no Turnstile secret). No variable is added. Rotating the
  Turnstile secret makes the day's counts start again once, which is harmless.
  `the_address_hash_key_is_not_derivable_from_the_service_token` proves the hash depends on the
  Turnstile secret and not on the service token.
- PLAN §19's inventory has two new rows: the free scanner's data (domain, origin, the keyed hash of
  the visitor's address, status and the bounded result; 24 hours, deleted by `free_scans_sweep()`),
  and the sealed storefront-password copy of a scan (until the scan ends, and no later than an
  hour, ADR-283).
- The privacy page's draft may say a keyed hash of the address is kept for 24 hours and that no
  address is stored. It remains a draft marked "attorney review required"; nothing was published.

## Consequences

Stored hashes from before this change no longer match new requests: each visitor's count starts
again once at deploy. Nothing has been deployed (the LTS pin comes first).
