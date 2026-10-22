# ADR-254: `rsctl doctor` checks the backup inputs for shape, offline

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Refines ADR-152, ADR-253

## Context

The founder enters the backup inputs by hand. A wrong shape (a recipient that is not an age recipient, a signing key that is not an Ed25519 key) fails a night later in a cron service nobody watches.

## Decision

`rsctl doctor` checks, without a network call, that the age recipients parse, that two recipients exist (warning if one), that the signing key is base64 of a 64-character line, that the drill private key has the age identity shape, and that the bucket names end in the environment. It never prints a value. Bucket locks and lifecycle cannot be checked (ADR-252).

## Consequences

A typo is found at setup time.

## Rejected alternatives

- A live check against R2: needs the write token on the founder's machine.
