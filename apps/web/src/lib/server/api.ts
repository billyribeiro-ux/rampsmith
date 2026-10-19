/**
 * The typed api client for server code (ADR-005, ADR-009). Every request carries the
 * current W3C trace context, so the api's spans join the SvelteKit request's trace
 * (PLAN §21).
 */
import { context, propagation } from '@opentelemetry/api';
import { createApiClient, type ApiClient } from '@rampsmith/contracts-ts';

type Fetch = typeof globalThis.fetch;

/** `fetchImpl` with `traceparent` (and `tracestate`) injected from the active context. */
function tracedFetch(fetchImpl: Fetch): Fetch {
  return (input, init) => {
    const request = new Request(input, init);
    propagation.inject(context.active(), request.headers, {
      set: (headers, key, value) => {
        headers.set(key, value);
      },
    });
    return fetchImpl(request);
  };
}

/** A client for the api at `baseUrl`. */
export function apiClient(baseUrl: string, fetchImpl: Fetch = globalThis.fetch): ApiClient {
  return createApiClient(baseUrl, tracedFetch(fetchImpl));
}
