/**
 * The BFF route table: which browser requests may reach which api operations (ADR-005,
 * ADR-091). The browser asks `/app/api/shopify/<path>`; only the operations the App Home uses
 * pass, with the methods and query parameters each allows, so this is not an open proxy.
 */
import { RETRY_HEADER } from '#lib/shopify/session-fetch.ts';
import { bearer, problem, unauthenticated, upstream } from './upstream.server.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MAX_BODY_BYTES = 64 * 1024;

interface Route {
  readonly methods: readonly string[];
  readonly path: RegExp;
  /** Query parameters passed on to the api. */
  readonly query: readonly string[];
}

const ROUTES: readonly Route[] = [
  { methods: ['GET'], path: /^overview$/u, query: [] },
  { methods: ['POST'], path: /^scans$/u, query: [] },
  { methods: ['GET'], path: new RegExp(`^scans/${UUID}$`, 'u'), query: [] },
  {
    methods: ['GET'],
    path: /^findings$/u,
    query: ['impact', 'status', 'origin', 'criterion', 'has_fix', 'cursor'],
  },
  { methods: ['GET'], path: new RegExp(`^findings/${UUID}$`, 'u'), query: [] },
  { methods: ['GET'], path: /^fixes$/u, query: ['state', 'cursor'] },
  { methods: ['PUT'], path: new RegExp(`^fixes/${UUID}$`, 'u'), query: [] },
  {
    methods: ['POST'],
    path: new RegExp(`^fixes/${UUID}/approve$`, 'u'),
    query: ['confirm_flagged'],
  },
  { methods: ['POST'], path: new RegExp(`^fixes/${UUID}/(?:reject|undo)$`, 'u'), query: [] },
  { methods: ['GET'], path: new RegExp(`^evidence/${UUID}$`, 'u'), query: [] },
  { methods: ['GET', 'PUT'], path: /^settings$/u, query: [] },
  { methods: ['GET', 'PUT'], path: /^email-preferences$/u, query: [] },
  { methods: ['GET', 'PUT'], path: /^statement$/u, query: [] },
  { methods: ['GET'], path: /^code-fixes$/u, query: [] },
  { methods: ['POST', 'DELETE'], path: /^code-fixes\/connection$/u, query: [] },
  { methods: ['PUT'], path: /^code-fixes\/repository$/u, query: [] },
  { methods: ['POST'], path: /^code-fixes\/batches$/u, query: [] },
];

const SAFE_VALUE = /^[A-Za-z0-9_.:=+/-]{1,300}$/u;

export type Resolution =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly status: 404 | 405 };

/** Maps a browser request to the api path, or says why it may not pass. */
export function resolve(method: string, path: string, search: URLSearchParams): Resolution {
  const route = ROUTES.find((r) => r.path.test(path));
  if (route === undefined) return { ok: false, status: 404 };
  if (!route.methods.includes(method)) return { ok: false, status: 405 };
  const query = new URLSearchParams();
  for (const key of route.query) {
    const value = search.get(key);
    if (value !== null && SAFE_VALUE.test(value)) query.set(key, value);
  }
  const qs = query.toString();
  return { ok: true, path: qs === '' ? path : `${path}?${qs}` };
}

type Fetch = typeof globalThis.fetch;

/** Forwards one browser request to the api and returns its answer. */
export async function forward(
  apiUrl: string,
  request: Request,
  path: string,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const resolved = resolve(request.method, path, url.searchParams);
  if (!resolved.ok) {
    return resolved.status === 404
      ? problem(404, 'not_found', 'Not found')
      : problem(405, 'bad_request', 'Method not allowed');
  }
  const authorization = bearer(request);
  if (authorization === undefined) return unauthenticated();

  const init: RequestInit = { method: request.method };
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return problem(413, 'payload_too_large', 'Request too large');
    }
    init.body = body === '' ? '{}' : body;
    init.headers = { 'content-type': 'application/json' };
  }

  let response: Response;
  try {
    response = await upstream(apiUrl, authorization, fetchImpl).call(resolved.path, init);
  } catch {
    return problem(503, 'unavailable', 'Service unavailable');
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  const type = response.headers.get('content-type');
  if (type !== null) headers.set('content-type', type);
  if (response.headers.get(RETRY_HEADER) === '1') headers.set(RETRY_HEADER, '1');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}
