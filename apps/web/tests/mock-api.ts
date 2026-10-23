/**
 * A stand-in for the api in browser tests: `POST /v1/shopify/session` accepts the bearer
 * token `good` and asks App Bridge for a fresh token on anything else, like the real api. It
 * also plays the free scanner's endpoints (ADR-267) for the web server running in `api` mode.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import process from 'node:process';

const port = Number(process.env['MOCK_API_PORT'] ?? '3998');

/** The service token the web server under test presents (see playwright.config.ts). */
const SERVICE_TOKEN = 'e2e-service-token-0123456789abcdef0123456789';
const FREE_SCAN_ID = '0199c0de-0000-7000-8000-0000000000f1';
const OTHER_FREE_SCAN_ID = '0199c0de-0000-7000-8000-0000000000f2';

/** What the free scanner's requests carried, for the tests to read back. */
const freeScanCalls: {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}[] = [];
let freeScanPolls = 0;

const freeScanResult = (domain: string) => ({
  domain,
  scanned_at: '2026-10-22T10:00:00Z',
  pages: [`https://${domain}/`, `https://${domain}/collections/all`],
  checks_passed: 38,
  checks_run: 44,
  failures: [
    {
      rule_id: 'image-alt',
      title: 'Images must have alternative text',
      criterion: '1.1.1',
      count: 7,
      examples: [{ page: `https://${domain}/`, snippet: '<img src="/a.jpg">' }],
    },
  ],
});

const freeScanBody = (id: string, domain: string, status: string, extra: object = {}) =>
  JSON.stringify({ id, domain, status, refusal: null, result: null, cached: false, ...extra });

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function problem(status: number, errors: object[], headers: Record<string, string> = {}) {
  return {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
    body: JSON.stringify({ type: '/problems/x', title: 'x', status, code: 'x', errors }),
  };
}

/** The free scanner's endpoints. Returns false for a path that is not one of them. */
async function freeScans(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const path = request.url ?? '';
  if (request.method === 'GET' && path === '/_free_scan_calls') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(freeScanCalls));
    return true;
  }
  if (!path.startsWith('/v1/free-scans')) return false;
  const raw = request.method === 'POST' ? await readBody(request) : '';
  const body = raw === '' ? undefined : (JSON.parse(raw) as { url?: string });
  freeScanCalls.push({
    method: request.method ?? '',
    path,
    authorization: request.headers.authorization,
    body,
  });
  const json = (status: number, text: string) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(text);
  if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
    json(401, '{"code":"unauthenticated"}');
    return true;
  }
  if (request.method === 'POST') {
    const url = body?.url ?? '';
    if (url.includes('limit')) {
      const refused = problem(429, [{ field: 'limit', message: 'ip' }], { 'retry-after': '7200' });
      response.writeHead(refused.status, refused.headers).end(refused.body);
    } else if (url.includes('busy')) {
      const refused = problem(503, []);
      response.writeHead(refused.status, refused.headers).end(refused.body);
    } else if (url.includes('no-engine')) {
      // No engine with a sandboxed browser is serving free scans (ADR-280).
      const refused = problem(503, [{ field: 'scanner', message: 'unavailable' }]);
      response.writeHead(refused.status, refused.headers).end(refused.body);
    } else if (url.includes('robots')) {
      json(
        200,
        freeScanBody(OTHER_FREE_SCAN_ID, 'robots-shop.com', 'refused', { refusal: 'robots' }),
      );
    } else {
      freeScanPolls = 0;
      json(202, freeScanBody(FREE_SCAN_ID, 'example.com', 'queued'));
    }
    return true;
  }
  // The scan runs for one look, then is done.
  freeScanPolls += 1;
  json(
    200,
    freeScanPolls < 2
      ? freeScanBody(FREE_SCAN_ID, 'example.com', 'running')
      : freeScanBody(FREE_SCAN_ID, 'example.com', 'complete', {
          result: freeScanResult('example.com'),
        }),
  );
  return true;
}

/**
 * The email-link pages' endpoints (ADR-274). Tokens: `unsub-ok` (one category), `prefs-ok` (every
 * category the app offers), `expired`; anything else is not one of ours. Switches are kept per
 * token, like the api keeps them per address.
 */
const emailOff = new Set<string>();

function emailView(token: string) {
  if (token === 'expired') return { status: 'expired', purpose: null, categories: [] };
  if (token !== 'unsub-ok' && token !== 'prefs-ok' && token !== 'prefs-both') {
    return { status: 'invalid', purpose: null, categories: [] };
  }
  const categories = token === 'prefs-both' ? ['notification', 'marketing'] : ['notification'];
  return {
    status: 'ok',
    purpose: token === 'unsub-ok' ? 'unsubscribe' : 'preferences',
    categories: categories.map((category) => ({
      category,
      enabled: !emailOff.has(`${token}:${category}`),
    })),
  };
}

async function emailLinks(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const path = request.url ?? '';
  if (request.method !== 'POST' || !path.startsWith('/v1/email/links/')) return false;
  const body = JSON.parse((await readBody(request)) || '{}') as {
    token?: string;
    category?: string;
    enabled?: boolean;
  };
  const token = body.token ?? '';
  if (path === '/v1/email/links/preference' && emailView(token).status === 'ok') {
    const key = `${token}:${body.category ?? ''}`;
    if (body.enabled === true) emailOff.delete(key);
    else emailOff.add(key);
  }
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify(emailView(token)));
  return true;
}

/** What the GitHub callback route sent, for the tests to read back (never the real code). */
const githubCallbacks: object[] = [];

async function githubHops(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const path = request.url ?? '';
  if (request.method === 'GET' && path === '/__github') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(githubCallbacks));
    return true;
  }
  if (request.method !== 'POST' || path !== '/v1/github/callback') return false;
  const body = JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>;
  githubCallbacks.push(body);
  const status = { denied: 403, taken: 409, spent: 400, down: 502 }[String(body['code'])] ?? 200;
  response
    .writeHead(status, {
      'content-type': status === 200 ? 'application/json' : 'application/problem+json',
    })
    .end(JSON.stringify(status === 200 ? { connected: true } : { status, code: 'x' }));
  return true;
}

createServer((request, response) => {
  void githubHops(request, response).then((github) => {
    if (github) return;
    route2(request, response);
  });
}).listen(port, '127.0.0.1');

function route2(request: IncomingMessage, response: ServerResponse): void {
  void emailLinks(request, response).then((done) => {
    if (done) return;
    void freeScans(request, response).then((handled) => {
      if (!handled) route(request, response);
    });
  });
}

function route(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/shopify/overview') {
    // Enough of the App Home's overview for the shell tests: a shop that has never scanned.
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        shop: { domain: 'demo-store.myshopify.com', name: 'Demo Store' },
        entitlements: {
          plan: 'free',
          scan_cadence: 'monthly',
          alt_text_drafts: { limit: 25, used: 0, renews_at: null },
          features: [],
        },
        latest_scan: null,
        next_scan_at: null,
        open_by_impact: { minor: 0, moderate: 0, serious: 0, critical: 0 },
        fixes_awaiting_approval: 0,
        fixes_applied: 0,
        first_fix_at: null,
      }),
    );
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/shopify/session') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization === 'Bearer good') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ shop: 'demo-store.myshopify.com', installed: true }));
    return;
  }
  response
    .writeHead(401, {
      'content-type': 'application/problem+json',
      'x-shopify-retry-invalid-session-request': '1',
    })
    .end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Authentication required',
        status: 401,
        code: 'unauthenticated',
      }),
    );
}
