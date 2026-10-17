# ADR-009: Contracts are generated

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Three deployables in two languages exchange HTTP requests and job payloads. Hand-written duplicate types drift silently.

## Decision

`utoipa` generates the OpenAPI document from the Rust handlers and `openapi-typescript` generates the web client from it. `schemars` generates JSON Schema for job payloads; `json-schema-to-typescript` generates engine types and Ajv validates payloads at runtime. Generated files are committed, and CI regenerates them and fails on any difference.

## Consequences

- One source of truth per boundary.
- Generated packages (`packages/contracts-ts`) are never hand-edited.

## Rejected alternatives

- Hand-written duplicate types.
