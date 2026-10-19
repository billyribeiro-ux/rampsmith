/**
 * A typed client for the api, generated from its OpenAPI document. Only SvelteKit's server
 * uses it; browsers never call the api (ADR-005).
 */
import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './generated/api.ts';

export type ApiClient = Client<paths>;

export function createApiClient(baseUrl: string, fetchImpl?: typeof globalThis.fetch): ApiClient {
  return createClient<paths>(fetchImpl === undefined ? { baseUrl } : { baseUrl, fetch: fetchImpl });
}
