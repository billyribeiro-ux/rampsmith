/**
 * Calls from the BFF to the Rust api on behalf of the embedded app: the App Bridge session
 * token is forwarded as is (the api verifies it, ADR-022), the W3C trace context is injected so
 * the api's spans join the request's trace (PLAN §21), and nothing is logged or stored.
 */
import { context, propagation } from '@opentelemetry/api';
import { RETRY_HEADER } from '#lib/shopify/session-fetch.ts';

type Fetch = typeof globalThis.fetch;

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UPSTREAM_TIMEOUT_MS = 25_000;

export function problem(
  status: number,
  code: string,
  title: string,
  options: {
    readonly retry?: boolean;
    readonly errors?: readonly { readonly field: string; readonly message: string }[];
  } = {},
): Response {
  const headers = new Headers({ ...NO_STORE, 'content-type': 'application/problem+json' });
  if (options.retry === true) headers.set(RETRY_HEADER, '1');
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title,
      status,
      code,
      ...(options.errors === undefined ? {} : { errors: options.errors }),
    }),
    {
      status,
      headers,
    },
  );
}

/** The `Authorization` value if it is a bearer token, else `undefined`. */
export function bearer(request: Request): string | undefined {
  const value = request.headers.get('authorization')?.trim();
  return value !== undefined && /^bearer\s+\S+$/iu.test(value) ? value : undefined;
}

export function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication required', { retry: true });
}

export interface Upstream {
  /** Calls `path` under `/v1/shopify/` with the visitor's token. */
  call(path: string, init?: RequestInit): Promise<Response>;
}

export function upstream(
  baseUrl: string,
  authorization: string,
  fetchImpl: Fetch = fetch,
): Upstream {
  const root = baseUrl.replace(/\/+$/u, '');
  return {
    call(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set('authorization', authorization);
      headers.set('accept', headers.get('accept') ?? 'application/json');
      propagation.inject(context.active(), headers, {
        set: (carrier, key, value) => {
          carrier.set(key, value);
        },
      });
      return fetchImpl(`${root}/v1/shopify/${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    },
  };
}

/** Reads a JSON body from an upstream answer, or `undefined` if it is not an object. */
export async function jsonBody<T>(response: Response): Promise<T | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  return typeof body === 'object' && body !== null ? (body as T) : undefined;
}

/** The answer to give the browser when an upstream call did not succeed. */
export function failureFrom(response: Response): Response {
  const headers = new Headers({ ...NO_STORE, 'content-type': 'application/problem+json' });
  if (response.headers.get(RETRY_HEADER) === '1') headers.set(RETRY_HEADER, '1');
  return new Response(response.body, { status: response.status, headers });
}
