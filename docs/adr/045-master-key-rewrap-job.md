# ADR-045: Re-wrapping stored tokens when the master key rotates

- Status: Accepted
- Date: 2026-10-19
- Amends: ADR-021 (envelope encryption), decision 4
- Source: R0 security audit finding L6 (`docs/evidence/r0-security-audit-2026-10-19.md`)

## Context

ADR-021 describes rotation as "prepend a key, re-wrap old values with `KeyRing::rewrap`, then
drop the old key". `KeyRing::rewrap` existed and was tested, but nothing called it: no job found
the rows under the old key and wrote them back, so the old key could never be retired. The
documentation of `rewrap` and ADR-021 also said "the value is never decrypted", which is not
what the code does: `envelope::rewrap` opens the data ciphertext once with the unwrapped data key
and drops the plaintext, to prove that the caller's context opens the value before the key is
bound to it again. That check is worth keeping (it refuses a ciphertext that was moved to another
slot, and one whose bytes were damaged) and the sentence was wrong.

Two things make the job less obvious than a loop over a table:

- `shopify_tokens` is under row-level security with a policy that needs `app.tenant_id`, and the
  worker role runs across tenants. It cannot list "the rows not under the active key" directly.
- The token refresh job (ADR-022, ADR-044) replaces these rows by compare-and-swap on `version`.
  A re-wrap that raced with a refresh must neither undo the refresh nor make it fail.

## Decision

### 1. Documentation

`KeyRing::rewrap` now says what it does: the data ciphertext is carried over byte for byte, the
value is decrypted once inside the call and dropped, `Authentication` means a wrong context or
damaged bytes, `UnknownKey` means the ring lacks the row's key. A test pins both facts (the
ciphertext tail is unchanged; a flipped bit in it is refused). ADR-021 decision 4 is corrected
below.

### 2. Finding the rows

Migration `20261101000002` adds two `SECURITY DEFINER` functions, executable by
`rampsmith_worker` only, in the style of `app_shop_by_domain` and `identity_sweep`:

- `shopify_tokens_to_rewrap(active_key_id, after_shop, batch)` returns `(tenant_id, shop_id,
  version)` of up to `batch` (clamped to 1 to 1000) rows whose `key_id` differs, in shop id order
  after `after_shop`. Paging by shop id means a row that cannot be re-wrapped is passed over
  and not returned for ever.
- `shopify_token_key_counts()` returns the number of rows per `key_id`.

Neither returns ciphertext. The worker already sees every job's tenant id; the new exposure is
the list of shop and tenant ids that hold tokens under old keys. They are surfaced as
`Db::tokens_to_rewrap` and `Db::token_key_counts`.

### 3. Writing a row

`ctl::rewrap::Rewrap::run` lists a batch, then for each row opens a transaction for that row's
tenant, reads the row again, re-wraps both tokens with the contexts the token lifecycle uses
(`shopify_auth::access_context` and `refresh_context`, now public so the two cannot drift), and
calls `db::repo::shopify::replace_wrapping`. That statement updates the ciphertexts and the key
id **where** tenant, shop, `version`, `key_id`, `access_ct` and `refresh_ct` all equal what was
read, and **does not change `version`**.

- Not bumping the version is deliberate. The tokens are the same, so a refresh that read the row
  before the swap and stores new tokens after it should win, and does. If the swap came second,
  the compare-and-swap in the swap fails and the next pass retries.
- The ciphertexts are in the condition because a version alone can repeat: a row that is
  deleted and stored again starts at version 0, and a ctl instance still running the old key ring
  seals under the old key. A swap based on a stale read would put the old tokens back. A test
  reproduces exactly that.
- The shop's token lock (ADR-041) is not taken. The lock exists to stop two token exchanges
  racing with Shopify; a re-wrap does not call Shopify, and the compare-and-swap is sufficient.

Rows that cannot be re-wrapped (unknown key, failed authentication) are logged with tenant id,
shop id, key id and the reason, counted as `failed` and left as they are. A row changed between
listing and writing is counted as `skipped`. Database errors end the pass. A pass is safe to
run any number of times, concurrently, and to stop at any point; a test runs two at once and
shows each row is written once.

### 4. The operator interface (for `rsctl`)

The operator command belongs to the `rsctl` workstream. It needs a database URL for a login
that is a member of `rampsmith_worker`, and the same `RAMPSMITH_MASTER_KEYS` the services use,
with the new key first and the old keys still present. Then:

```rust
let db = db::Db::from_pool(pool);                      // role: rampsmith_worker
let job = ctl::rewrap::Rewrap::new(db, keys).with_batch(100);
let report = job.run().await?;                         // Report { examined, rewrapped, skipped, failed }
let left = job.remaining().await?;                     // Vec<db::KeyCount { key_id, tokens }>
```

Rotation procedure: (1) generate a key (`KeyRing::generate_master_key`), (2) prepend `id:key` to
`RAMPSMITH_MASTER_KEYS` in every service and redeploy, (3) run the pass until `failed == 0`,
(4) `remaining()` lists only the new key id, (5) remove the old key from the ring and redeploy.
`ctl` itself does not run a pass on a schedule; whether it should is a decision for the
operator command's design. Until `rsctl` has the command, a pass is a few lines in a test or a
one-off binary.

## Consequences

- A master key can be retired for the first time. Until step 5, losing the old key still loses
  the rows under it.
- The listing is cross-tenant and bypasses row-level security by design, behind a function
  only the worker role can run, that returns ids and a version.
- Rows are rewritten without a version change, so anything that used `version` to detect
  "something changed" would miss a re-wrap. Nothing does today; the version means "the tokens
  changed" (ADR-044).

## Plan correction

ADR-021 decision 4: replace "(the value is never decrypted)" with "(the data ciphertext is kept
as it is; the value is decrypted once and dropped, to prove the context)", and add "A re-wrap
pass is `ctl::rewrap::Rewrap` (ADR-045)". PLAN §14 step 5 and §18: key rotation is a pass of
that job followed by removing the old key once `remaining()` no longer lists it.

## Rejected alternatives

- **A queue job (`system.rewrap`).** Fits the worker, but a new payload schema belongs in
  `crates/contracts`, outside this change, and an operator wants the result printed, not stored.
- **Bumping `version`.** Would make a concurrent refresh fail its compare-and-swap for no
  reason, and would turn every rotation into a burst of failed refreshes.
- **Taking the shop lock.** Serialises with token exchange, which a re-wrap does not need, and
  the lock key is the shop domain, which this job does not otherwise handle.
- **Granting the worker a policy on `shopify_tokens` across tenants.** It would widen every
  worker query on the table; two narrow definer functions widen nothing else.
