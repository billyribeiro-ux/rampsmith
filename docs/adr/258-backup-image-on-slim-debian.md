# ADR-258: The backup image is slim Debian with the PGDG client only, and CI scans it

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Closes MEDIUM-1; refines ADR-171

## Context

The backup image was based on the PostgreSQL server image (server, gosu, many libraries) and was missing from the image scan matrix and from `fail-fast: false` in the release verify job, so one failing scan hid the others.

## Decision

- `infra/backup/Dockerfile` is `debian:bookworm-slim` pinned by digest, with only `postgresql-client-18` from the PGDG repository (key fetched by full fingerprint), `openssl`, `python3` for the pinned AWS CLI venv, security updates applied at build, and no server or gosu. The tool-check step fails the build if a `postgres` binary or `gosu` is present.
- age stays at v1.3.2 with its pinned checksum (re-checked against the FiloSottile/age releases on 22 Oct 2026).
- `ci.yml` scans `backup` in the `images` matrix; `release.yml` `verify` runs with `fail-fast: false`.

## Consequences

A smaller attack surface, and a failing image is visible alongside the others.

## Rejected alternatives

- Keep the postgres base image: ships a server and gosu the job never uses.
