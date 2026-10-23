# ADR-289: Scan ring rotation gives the engine the new key first

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-266
- Source: audit of the R1 integration, finding L7

## Context

ADR-266 introduced `RAMPSMITH_SCAN_SECRET_KEYS`, a ring held by `ctl` and the engine, and no
procedure for rotating it. A rotation that makes `ctl` seal under a key the engine lacks leaves the
scan without its password.

## Decision

`docs/runbooks/rotate-scan-secret-keys.md` rotates in three deploys: the new key added last (the
engine and `ctl` learn it, `ctl` still seals under the old one), then first (`ctl` seals under it),
then the old key dropped no earlier than an hour later (the sweep of ADR-283 has cleared any copy
sealed under it). `crates/crypto/tests/vector.rs` and `packages/engine/test/scan-secret.test.ts` pin
the rule with a copy sealed under each key (`vectors/scan-secret.txt`): a ring with both keys opens
both; a ring without the new key cannot open the new copy.

## Consequences

The Railway steps are unrun until staging exists (LAUNCH.md section E). The runbook is outside the nine
of PLAN §22 and is listed in `docs/runbooks/README.md`.
