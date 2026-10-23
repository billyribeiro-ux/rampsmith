# ADR-257: Restore as a non-superuser and refuse archives with out-of-schema entries

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Closes finding M2; refines ADR-176

## Context

`pg_restore` as a superuser runs whatever the archive contains, including `ALTER ROLE`, `CREATE EXTENSION` with untrusted code and `COPY ... PROGRAM`-style objects in a crafted archive. The restore and the verification both ran as the bootstrap superuser.

## Decision

- `restore.sh` connects as `rampsmith_migrator` (non-superuser, CREATEROLE), uses `--no-owner` and no `--role`. `RESTORE_ALLOW_SUPERUSER=1` is the documented break-glass. `verify.sh` refuses a superuser connection unless `VERIFY_ALLOW_SUPERUSER=1`.
- Before restoring, `rd_toc_violations` reads the archive's table of contents and refuses any entry outside an allow-list: the `public` schema; TABLE, TABLE DATA, CONSTRAINT, FK CONSTRAINT, CHECK CONSTRAINT, INDEX, TRIGGER, POLICY, ROW SECURITY, FUNCTION, SEQUENCE and its OWNED BY and SET, VIEW, TYPE, DOMAIN, DEFAULT, ACL, COMMENT, SCHEMA public. Verified: the real schema has zero violations; the negative suite adds a foreign-schema fault.

## Consequences

A crafted archive fails before it touches the target.

## Rejected alternatives

- Superuser restore with a TOC scan only: still runs unknown code if the scan has a gap.
