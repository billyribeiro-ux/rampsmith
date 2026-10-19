/**
 * Data requests from the embedded app carry a fresh App Bridge session token as a bearer
 * header (shopify.dev, "ID tokens"). The token is attached explicitly rather than relying on
 * App Bridge's fetch interceptor, and a 401 carrying the retry header is retried once with a
 * new token, as App Bridge itself would (ADR-022).
 */
export const RETRY_HEADER = 'x-shopify-retry-invalid-session-request';

/** The part of the App Bridge `shopify` global this module needs. */
export interface SessionTokenSource {
  idToken(): Promise<string>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function once(
  source: SessionTokenSource,
  fetchImpl: Fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await source.idToken()}`);
  return fetchImpl(input, { ...init, headers });
}

/** `fetch` with a session token, retried once when the server asks for a fresh one. */
export async function sessionFetch(
  source: SessionTokenSource,
  fetchImpl: Fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const first = await once(source, fetchImpl, input, init);
  if (first.status !== 401 || first.headers.get(RETRY_HEADER) !== '1') {
    return first;
  }
  return once(source, fetchImpl, input, init);
}
