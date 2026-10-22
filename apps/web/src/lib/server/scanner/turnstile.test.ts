import { describe, expect, it } from 'vitest';
import { TURNSTILE_ORIGIN, verifyTurnstile } from './turnstile.ts';

interface Call {
  url: string;
  body: URLSearchParams;
}

function fakeFetch(reply: () => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: new URLSearchParams(typeof body === 'string' ? body : ''),
    });
    return reply();
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('verifyTurnstile', () => {
  it("posts the secret, token and visitor IP to Cloudflare's siteverify endpoint", async () => {
    const calls: Call[] = [];
    const verdict = await verifyTurnstile({
      secret: 'secret-1',
      token: 'token-1',
      remoteIp: '203.0.113.9',
      fetch: fakeFetch(() => json({ success: true, hostname: 'rampsmith.example' }), calls),
    });
    expect(verdict).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`);
    expect(calls[0]?.body.get('secret')).toBe('secret-1');
    expect(calls[0]?.body.get('response')).toBe('token-1');
    expect(calls[0]?.body.get('remoteip')).toBe('203.0.113.9');
  });

  it('uses the configured origin, for the test fake', async () => {
    const calls: Call[] = [];
    await verifyTurnstile({
      secret: 's',
      token: 't',
      origin: 'http://127.0.0.1:3990',
      fetch: fakeFetch(() => json({ success: true }), calls),
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3990/turnstile/v0/siteverify');
    expect(calls[0]?.body.has('remoteip')).toBe(false);
  });

  it('refuses a missing or oversized token without calling Cloudflare', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(() => json({ success: true }), calls);
    expect(await verifyTurnstile({ secret: 's', token: '', fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      await verifyTurnstile({ secret: 's', token: 'x'.repeat(2049), fetch: fetchImpl }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['timeout-or-duplicate', 'invalid'],
    ['invalid-input-response', 'invalid'],
    ['missing-input-response', 'invalid'],
  ])('maps %s to a failed challenge', async (code, reason) => {
    const verdict = await verifyTurnstile({
      secret: 's',
      token: 't',
      fetch: fakeFetch(() => json({ success: false, 'error-codes': [code] })),
    });
    expect(verdict).toEqual({ ok: false, reason });
  });

  it.each([
    ['invalid-input-secret'],
    ['missing-input-secret'],
    ['bad-request'],
    ['internal-error'],
  ])('treats %s as a service problem, not the visitor’s fault', async (code) => {
    const verdict = await verifyTurnstile({
      secret: 's',
      token: 't',
      fetch: fakeFetch(() => json({ success: false, 'error-codes': [code] })),
    });
    expect(verdict).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('fails closed when the request fails, times out or answers with junk', async () => {
    const throwing: typeof fetch = () => Promise.reject(new TypeError('network down'));
    expect(await verifyTurnstile({ secret: 's', token: 't', fetch: throwing })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(
      await verifyTurnstile({
        secret: 's',
        token: 't',
        fetch: fakeFetch(() => new Response('<html>', { status: 502 })),
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(
      await verifyTurnstile({
        secret: 's',
        token: 't',
        fetch: fakeFetch(() => json({ nonsense: true })),
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });
});
