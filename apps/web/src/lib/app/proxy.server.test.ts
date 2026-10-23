import { describe, expect, it, vi } from 'vitest';
import { forward, resolve } from './proxy.server.ts';

const ID = '00000000-0000-4000-8000-000000000101';
const q = (s = '') => new URLSearchParams(s);

describe('resolve', () => {
  it.each([
    ['GET', 'overview'],
    ['POST', 'scans'],
    ['GET', `scans/${ID}`],
    ['GET', 'findings'],
    ['GET', `findings/${ID}`],
    ['GET', 'fixes'],
    ['PUT', `fixes/${ID}`],
    ['POST', `fixes/${ID}/approve`],
    ['POST', `fixes/${ID}/reject`],
    ['POST', `fixes/${ID}/undo`],
    ['GET', 'regressions'],
    ['POST', `regressions/${ID}/dismiss`],
    ['GET', 'agency-links'],
    ['POST', 'agency-links'],
    ['POST', 'agency-links/preview'],
    ['DELETE', `agency-links/${ID}`],
    ['GET', `evidence/${ID}`],
    ['GET', 'settings'],
    ['PUT', 'settings'],
    ['GET', 'email-preferences'],
    ['PUT', 'email-preferences'],
    ['GET', 'statement'],
    ['PUT', 'statement'],
  ])('lets %s %s through', (method, path) => {
    expect(resolve(method, path, q())).toEqual({ ok: true, path });
  });

  it.each([
    'session',
    'billing/subscriptions',
    '../admin',
    'fixes/not-a-uuid',
    `fixes/${ID}/delete`,
    `fixes/${ID}/approve/extra`,
    `findings/${ID}/..`,
    'overview/extra',
    '',
  ])('does not know %j', (path) => {
    expect(resolve('GET', path, q())).toEqual({ ok: false, status: 404 });
  });

  it('refuses a method the operation does not take', () => {
    expect(resolve('DELETE', 'settings', q())).toEqual({ ok: false, status: 405 });
    expect(resolve('GET', `fixes/${ID}/approve`, q())).toEqual({ ok: false, status: 405 });
    expect(resolve('POST', 'overview', q())).toEqual({ ok: false, status: 405 });
    expect(resolve('GET', `agency-links/${ID}`, q())).toEqual({ ok: false, status: 405 });
    expect(resolve('DELETE', 'agency-links', q())).toEqual({ ok: false, status: 405 });
  });

  it('passes only the query parameters an operation lists, and only safe values', () => {
    const found = resolve(
      'GET',
      'findings',
      q('impact=serious&evil=1&origin=data&cursor=abc_123&criterion=1.1.1&status=a%0d%0ab'),
    );
    expect(found).toEqual({
      ok: true,
      path: 'findings?impact=serious&origin=data&criterion=1.1.1&cursor=abc_123',
    });
    expect(resolve('GET', 'overview', q('impact=serious'))).toEqual({ ok: true, path: 'overview' });
  });

  it('passes the confirmation of a flagged draft on approve and nowhere else (audit M1)', () => {
    expect(resolve('POST', `fixes/${ID}/approve`, q('confirm_flagged=true&evil=1'))).toEqual({
      ok: true,
      path: `fixes/${ID}/approve?confirm_flagged=true`,
    });
    expect(resolve('POST', `fixes/${ID}/reject`, q('confirm_flagged=true'))).toEqual({
      ok: true,
      path: `fixes/${ID}/reject`,
    });
    expect(resolve('POST', `fixes/${ID}/approve`, q('confirm_flagged=true%0d%0a'))).toEqual({
      ok: true,
      path: `fixes/${ID}/approve`,
    });
  });
});

describe('forward', () => {
  const api = 'http://api.internal:3000/';
  const request = (method: string, path: string, init: RequestInit = {}) =>
    new Request(`https://app.example/app/api/shopify/${path}`, { method, ...init });

  it('asks for a new session token when there is no bearer token', async () => {
    const fetchImpl = vi.fn();
    const response = await forward(api, request('GET', 'overview'), 'overview', fetchImpl);
    expect(response.status).toBe(401);
    expect(response.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 404 and 405 without calling the api', async () => {
    const fetchImpl = vi.fn();
    const headers = { authorization: 'Bearer t' };
    expect(
      (await forward(api, request('GET', 'session', { headers }), 'session', fetchImpl)).status,
    ).toBe(404);
    expect(
      (await forward(api, request('DELETE', 'settings', { headers }), 'settings', fetchImpl))
        .status,
    ).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards the visitor token and a JSON body, and returns the answer uncached', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          { echoed: new Headers(init?.headers).get('authorization'), body: init?.body },
          { headers: { 'x-shopify-retry-invalid-session-request': '1' } },
        ),
      ),
    );
    const response = await forward(
      api,
      request('PUT', 'settings', {
        headers: { authorization: 'Bearer visitor', 'x-forwarded-for': '1.2.3.4' },
        body: '{"weekly_rescan":true}',
      }),
      'settings',
      fetchImpl,
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'http://api.internal:3000/v1/shopify/settings',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
    expect(await response.json()).toEqual({
      echoed: 'Bearer visitor',
      body: '{"weekly_rescan":true}',
    });
    const sent = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(sent.get('x-forwarded-for')).toBeNull();
  });

  it('refuses a body over 64 KiB', async () => {
    const fetchImpl = vi.fn();
    const response = await forward(
      api,
      request('PUT', 'statement', {
        headers: { authorization: 'Bearer t' },
        body: 'x'.repeat(64 * 1024 + 1),
      }),
      'statement',
      fetchImpl,
    );
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says the service is unavailable when the api cannot be reached', async () => {
    const response = await forward(
      api,
      request('GET', 'overview', { headers: { authorization: 'Bearer t' } }),
      'overview',
      () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:3000')),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('10.0.0.1');
  });
});
