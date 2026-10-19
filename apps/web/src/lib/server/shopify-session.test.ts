import { context, propagation, trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api.ts';
import { forwardSession } from './shopify-session.ts';

const API = 'http://api.internal:8080';

type Handler = (request: Request) => Response | Promise<Response>;

function client(handler: Handler) {
  const seen: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    return handler(request);
  });
  return { client: apiClient(API, fetchImpl), seen };
}

describe('forwardSession', () => {
  it('passes the bearer token to the api and returns its answer', async () => {
    const { client: api, seen } = client(() =>
      Response.json({ shop: 'demo.myshopify.com', installed: true }),
    );
    const response = await forwardSession(api, 'Bearer abc.def.ghi');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ shop: 'demo.myshopify.com', installed: true });
    expect(seen[0]?.url).toBe(`${API}/v1/shopify/session`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer abc.def.ghi');
  });

  it('answers 401 with the retry header without calling the api when no token is sent', async () => {
    for (const authorization of [null, '', 'Basic x', 'Bearer ']) {
      const { client: api, seen } = client(() => new Response());
      const response = await forwardSession(api, authorization);
      expect(response.status, String(authorization)).toBe(401);
      expect(response.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
      expect(seen).toHaveLength(0);
    }
  });

  it("relays the api's problem and its retry header", async () => {
    const { client: api } = client(
      () =>
        new Response(
          JSON.stringify({ status: 401, code: 'unauthenticated', title: 'x', type: 'about:blank' }),
          {
            status: 401,
            headers: {
              'content-type': 'application/problem+json',
              'x-shopify-retry-invalid-session-request': '1',
            },
          },
        ),
    );
    const response = await forwardSession(api, 'Bearer stale');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('answers 503 when the api cannot be reached', async () => {
    const { client: api } = client(() => Promise.reject(new TypeError('fetch failed')));
    const response = await forwardSession(api, 'Bearer t');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
  });
});

describe('apiClient', () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });
  afterAll(() => {
    propagation.disable();
    context.disable();
  });

  it('carries the active trace context to the api', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    const active = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    });
    const { client: api, seen } = client(() => Response.json({ shop: 's', installed: false }));
    await context.with(active, () => forwardSession(api, 'Bearer t'));
    expect(seen[0]?.headers.get('traceparent')).toBe(`00-${traceId}-${spanId}-01`);
  });
});
