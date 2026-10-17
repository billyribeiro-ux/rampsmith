// Public entry point. Everything below `generated/` comes from crates/contracts and
// crates/api (ADR-009); never edit it by hand.
export type * from './generated/index.ts';
export type { components as ApiComponents, paths as ApiPaths } from './generated/api.ts';
export { createApiClient, type ApiClient } from './client.ts';
