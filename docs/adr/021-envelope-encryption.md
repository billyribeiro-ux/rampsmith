# ADR-021: Envelope encryption of secrets at rest

- Status: Accepted
- Date: 2026-10-17

## Context

PLAN §14 (step 5) and §18 require Shopify access and refresh tokens (and later GitHub
installation data and storefront passwords) to be encrypted in the application with a data
key per row, wrapped by a master key held only in the environment. `shopify_tokens` stores
`access_ct`, `refresh_ct` and one `key_id`. PLAN §7 pins `aes-gcm` 0.11.1, verified on
crates.io on 2026-10-17 together with its dependency tree (`aead` 0.6, `cipher` 0.5,
`crypto-common` 0.2, all already present or free of duplicate versions under cargo-deny).

## Decision

1. `crates/crypto` (`rampsmith-crypto`) owns the format. Each sealed value gets its own random
   256-bit data key, which is stricter than one key per row and needs no extra column: the
   wrapped key travels inside the value.
2. Format version 1: `version (1) ‖ wrap nonce (12) ‖ wrapped data key (32+16) ‖ value nonce
   (12) ‖ value ciphertext + tag`. Overhead is 89 bytes. Both layers are AES-256-GCM with
   random 96-bit nonces; each data key encrypts exactly one value.
3. Associated data: the wrap authenticates a domain-separation label, the master key id and a
   caller context; the value authenticates a label and the same context. Callers pass the
   slot identity, such as `shopify_tokens/access/<shop id>`, so a ciphertext moved to another
   row, column or key id fails to open.
4. The key ring is read from `RAMPSMITH_MASTER_KEYS` as `id:base64key[,id:base64key…]`, newest
   first. The first key seals; all keys open. Rotation prepends a key, re-wraps old values
   with `KeyRing::rewrap` (the value is never decrypted), then drops the old key.
5. Keys and plaintexts are wiped on drop (`zeroize`); opened text is returned as
   `secrecy::SecretString`; `Debug` shows key ids only.

## Consequences

- A database dump without the environment's key ring reveals no token.
- Losing every master key loses every stored token; merchants then re-authenticate through
  token exchange, which is recoverable but must never be the plan. Keys are backed up in the
  deployment's secret store (Railway variables) and in the founder's password manager.
- Changing the format means a new version byte and an `open` path for both versions.

## Rejected alternatives

- One data key per row shared by `access_ct` and `refresh_ct`: needs a `wrapped_key` column and
  saves nothing measurable.
- `aws-lc-rs` AEAD directly: it is already in the tree, but the plan pins `aes-gcm` and the
  RustCrypto API is simpler to audit for this use.
- Database-side encryption (`pgcrypto`): the key would have to reach the database.
