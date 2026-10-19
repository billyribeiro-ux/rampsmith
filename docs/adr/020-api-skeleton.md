# ADR-020: api skeleton, OpenAPI pipeline and images

- Status: Accepted
- Date: 2026-10-17
- Refines: PLAN §7, §8, §22, §24; ADR-009, ADR-016

## Context

R0 step 6 builds the `api` skeleton: health and readiness, problem+json errors and OpenAPI
generation. It is also the first deployable, so the image stage of the pull-request gate
(ADR-016) starts here.

## Decision

1. **Routes declare the contract.** Handlers carry `#[utoipa::path]` and are registered with
   `utoipa-axum` 0.3.0 (crates.io, 2026-09-22; requires axum ^0.8.4 and utoipa ^6), so a
   route cannot exist without its OpenAPI entry. `utoipa-axum` is the one dependency added
   beyond PLAN §7.
2. **One error shape.** `http-kit::ApiError` renders RFC 9457 problem+json with the request's
   trace id. A response-mapping layer rewrites every bodiless error from a layer (timeout →
   503, body limit → 413, unknown route → 404) into problem+json, and panics become a 500
   problem that never echoes the panic payload. Database errors map to stable codes; the
   constraint names stay in logs.
3. **Middleware defaults.** UUIDv7 `x-request-id` (a caller's id is kept), one
   `http.request` span per request, sensitive headers redacted (authorization, cookies,
   Shopify, GitHub and Stripe signatures), 30-second timeout, 1 MiB body limit.
4. **Liveness and readiness.** `/healthz` never touches dependencies. `/readyz` requires the
   database to answer and to hold at least this build's newest migration, read through the
   security-definer `app_schema_version()`; a newer schema is fine (expand-then-contract).
   The pool connects lazily, so a service starts and reports "not ready" instead of
   crash-looping while the database is down.
5. **Configuration** is read once into a typed struct; the database URL is a
   `secrecy::SecretString`, and error messages never echo values.
6. **OpenAPI to TypeScript.** `gen-openapi` writes `packages/contracts-ts/openapi/api.json`;
   `openapi-typescript` 7.13.0 turns it into `src/generated/api.ts`, and `createApiClient`
   wraps `openapi-fetch` 0.17.0 for the SvelteKit server. `openapi-typescript` declares
   `typescript ^5.x`; it runs correctly on the pinned 6.0.3, which the gate proves by
   type-checking its output under the strict configuration, so `pnpm-workspace.yaml` allows
   that one peer range. `check:contracts` regenerates and diffs the document and the types.
7. **Images.** `infra/api.Dockerfile` builds on `rust:1.99.1-slim-trixie` and runs on
   `debian:trixie-slim` as UID 10001, both pinned by index digest read from Docker Hub on
   2026-10-17. PLAN §22 names a distroless base; its digest lives on `gcr.io`, which this
   session cannot query, so Debian slim stands in until the digest can be verified.
   The `images` CI job builds the image, smoke-tests liveness, readiness and the non-root
   user, writes a CycloneDX SBOM (syft v1.54.1) and fails on fixable high or critical
   vulnerabilities (grype v0.120.1). Tool versions are pinned like everything else.
   The runtime stage runs `apt-get upgrade` before installing `ca-certificates`: the first
   CI run found CVE-2026-103111 in `libpcre2-8-0` (fixed in `10.46-1~deb13u3`) inside the
   pinned base, and a fixed Debian security update should not wait for a digest bump. The
   gate stays at fixable high or critical; it was not loosened.

## Consequences

- New endpoints must be added through `routes!`, which keeps the drift check meaningful.
- The runtime image carries `ca-certificates` for TLS to the OTLP collector and providers.
- Moving to distroless is a one-line base-image change plus removal of the `apt-get` step.

## Rejected alternatives

- Hand-maintained OpenAPI or `utoipa` without `utoipa-axum`: the document could list routes
  the router lacks, or miss routes it has.
- Eager database connection at boot: a database blip during deploy would crash-loop the
  service instead of holding it out of rotation.
