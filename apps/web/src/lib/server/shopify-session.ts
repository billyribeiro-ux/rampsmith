/**
 * Forwards the embedded app's session start to the api (ADR-005, ADR-022). The browser's
 * bearer token is passed through untouched; the api's answer, including the App Bridge
 * retry header, comes back as is. Nothing here logs or stores the token.
 */
import type { ApiClient } from '@rampsmith/contracts-ts';
import { RETRY_HEADER } from '../shopify/session-fetch.ts';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function problem(status: number, code: string, title: string, retry = false): Response {
  const headers = new Headers({ ...NO_STORE, 'content-type': 'application/problem+json' });
  if (retry) headers.set(RETRY_HEADER, '1');
  return new Response(JSON.stringify({ type: 'about:blank', title, status, code }), {
    status,
    headers,
  });
}

/** Answers `POST /app/api/session` for a request bearing `authorization`. */
export async function forwardSession(
  client: ApiClient,
  authorization: string | null,
): Promise<Response> {
  if (authorization === null || !/^bearer\s+\S+$/i.test(authorization.trim())) {
    return problem(401, 'unauthenticated', 'Authentication required', true);
  }
  let result: Awaited<ReturnType<ApiClient['POST']>>;
  try {
    result = await client.POST('/v1/shopify/session', {
      headers: { authorization: authorization.trim() },
    });
  } catch {
    return problem(503, 'unavailable', 'Service unavailable');
  }
  const { data, error, response } = result;
  if (data !== undefined) {
    return Response.json(data, { headers: NO_STORE });
  }
  const headers = new Headers({ ...NO_STORE, 'content-type': 'application/problem+json' });
  if (response.headers.get(RETRY_HEADER) === '1') headers.set(RETRY_HEADER, '1');
  return new Response(JSON.stringify(error), { status: response.status, headers });
}
