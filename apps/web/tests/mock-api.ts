/**
 * A stand-in for the api in browser tests: `POST /v1/shopify/session` accepts the bearer
 * token `good` and asks App Bridge for a fresh token on anything else, like the real api.
 */
import { createServer } from 'node:http';
import process from 'node:process';

const port = Number(process.env['MOCK_API_PORT'] ?? '3998');

createServer((request, response) => {
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
}).listen(port, '127.0.0.1');
