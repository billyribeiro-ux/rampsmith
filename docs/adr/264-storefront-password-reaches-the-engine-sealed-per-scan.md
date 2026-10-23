# ADR-264: A protected store's password reaches the engine sealed for one scan

- Status: Accepted
- Date: 2026-10-22

## Context

A store behind Shopify's storefront password (ADR-071) can be scanned only if the engine enters
the password. The merchant saves it in the App Home; the api seals it under the master keys
(`sites.storefront_password_ct`, context `sites/storefront_password/<site>`, ADR-021). The engine
must never hold a master key or a Shopify token (ADR-035), and `EngineDeps.storefrontPassword`
is the seam where it receives the password, for one scan, to type into the form and then forget.
Until now nothing supplied it, so every protected store was reported as blocked.

Three ways to fill the seam were considered against the evidence in the code:

1. Give the engine the master keys. Rejected by ADR-035: one compromised Chromium process would
   then read every tenant's tokens and passwords.
2. Have `ctl` write the plaintext password to the database for the engine to read. The password
   would sit in clear in the table, its backups and its replicas.
3. Have `ctl`, which holds the master keys, open the stored password and seal it again under a
   key the engine can also hold, for one scan only.

## Decision

Option 3.

- A second key ring, `RAMPSMITH_SCAN_SECRET_KEYS` (same `id:base64key[,id:...]` form and 32-byte
  keys as the master ring), is held by `ctl` and the engine and by no other service. It is not a
  master key: it opens nothing but these per-scan copies, and the context makes each copy open
  only for its own scan.
- When `ctl` creates the work for a scan of a site that has a saved password (the first scan in
  `shopify.read_store`, the verification scan in `shopify.apply_data_fix`), it opens the stored
  password under the master keys, seals it under the scan ring with context
  `scans/storefront_password/<scan id>` (envelope format v1, ADR-021) and stores the result in
  `scans.storefront_password_ct` and `scans.storefront_password_key_id`. A check keeps the two
  columns together.
- The engine's `storefrontPasswordFromScan` reads the columns for `(tenant, site, scan)` while
  the scan is queued or running, opens the copy and passes the plaintext to the page load. The
  plaintext lives in memory for the load. `ScanKeyRing` is a Node implementation of format v1;
  `crates/crypto/tests/vectors/scan-secret.txt` is opened by both implementations, so the two
  cannot drift.
- The copy is cleared when the scan finalises, when a verification scan ends, and when a scan
  fails (`scans::fail`). The 30-day sweep and tenant deletion remove it with the scan.
- Without the ring (either side), nothing is sealed and a protected store is reported as blocked,
  as before. A stored password that cannot be opened logs a warning that names the scan and no
  value, and the scan reports the store as blocked. The password, the keys and the sealed bytes
  are never logged.

## Consequences

- A compromised engine can read the passwords of the scans queued or running, not of every
  site, and only through the scan ring.
- Rotating the scan ring is cheap: copies live for one scan.
- The founder generates one more secret (`rsctl keys generate` prints the right form; LAUNCH.md
  section C row 12). Live proof of the whole path is LAUNCH.md section E (a real closed store).
- `ctl`'s master-key re-wrap (ADR-045) covers Shopify tokens only; it does not yet cover
  `sites.storefront_password_ct`. Until it does, retiring a master key needs the saved passwords
  re-entered. Recorded as an open item in `docs/evidence/r1-integration.md`.

## Rejected alternatives

- Master keys in the engine: see above.
- Plaintext in the table: see above.
- The engine asking the api for the password: a new authenticated channel into the service that
  holds the master keys, for one value; the database already is that channel for everything else.
