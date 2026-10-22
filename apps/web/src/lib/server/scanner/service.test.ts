import { describe, expect, it } from 'vitest';
import { fixtureScanner, notConnectedScanner, type FreeScanner } from './client.ts';
import { createFreeScanService, type FreeScanDeps } from './service.ts';
import type { TurnstileVerdict } from './turnstile.ts';

function setup(overrides: Partial<FreeScanDeps> = {}) {
  let now = 1_700_000_000_000;
  const verified: string[] = [];
  const deps: FreeScanDeps = {
    scanner: fixtureScanner(() => new Date(now)),
    verifyChallenge: (token) => {
      verified.push(token);
      const verdict: TurnstileVerdict =
        token === 'good'
          ? { ok: true }
          : { ok: false, reason: token === '' ? 'missing' : 'invalid' };
      return Promise.resolve(verdict);
    },
    now: () => now,
    ...overrides,
  };
  return {
    service: createFreeScanService(deps),
    verified,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ask = (url: string, ip = '203.0.113.1', token = 'good') => ({ url, ip, token });

describe('free scan service', () => {
  it('returns the scanner’s result for a public site', async () => {
    const { service } = setup();
    const outcome = await service.run(ask('example.com'));
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.result.domain).toBe('example.com');
      expect(outcome.cached).toBe(false);
    }
  });

  it('rejects a bad address before asking Cloudflare anything', async () => {
    const { service, verified } = setup();
    expect(await service.run(ask('http://127.0.0.1'))).toEqual({
      kind: 'invalid-url',
      reason: 'address',
    });
    expect(verified).toEqual([]);
  });

  it('stops a visitor whose challenge fails', async () => {
    const { service } = setup();
    expect(await service.run(ask('example.com', '203.0.113.1', 'bad'))).toEqual({
      kind: 'challenge-failed',
    });
    expect(await service.run(ask('example.com', '203.0.113.1', ''))).toEqual({
      kind: 'challenge-failed',
    });
  });

  it('reports a challenge service outage as unavailable, not as the visitor’s fault', async () => {
    const { service } = setup({
      verifyChallenge: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    });
    expect(await service.run(ask('example.com'))).toEqual({ kind: 'challenge-unavailable' });
  });

  it('allows three scans per IP a day and refuses the fourth', async () => {
    const { service } = setup();
    for (const site of ['a.com', 'b.com', 'c.com']) {
      expect((await service.run(ask(site))).kind).toBe('result');
    }
    const fourth = await service.run(ask('d.com'));
    expect(fourth.kind).toBe('rate-limited');
    if (fourth.kind === 'rate-limited') expect(fourth.scope).toBe('ip');
  });

  it('serves a second request for a domain from the 24-hour cache without using the IP’s quota', async () => {
    const { service } = setup();
    const first = await service.run(ask('example.com', '203.0.113.1'));
    const second = await service.run(ask('https://www.example.com/x', '203.0.113.2'));
    expect(first.kind).toBe('result');
    expect(second.kind).toBe('result');
    if (second.kind === 'result') expect(second.cached).toBe(true);
    // The second visitor spent no scan.
    for (const site of ['a.com', 'b.com', 'c.com']) {
      expect((await service.run(ask(site, '203.0.113.2'))).kind).toBe('result');
    }
  });

  it('allows one scan per domain a day once the cache is gone', async () => {
    const { service, advance } = setup();
    expect((await service.run(ask('example.com', '203.0.113.1'))).kind).toBe('result');
    advance(23 * 60 * 60 * 1000);
    // Cached, so still served.
    expect((await service.run(ask('example.com', '203.0.113.2'))).kind).toBe('result');
    advance(2 * 60 * 60 * 1000);
    // A day has passed: a fresh scan is allowed again.
    const again = await service.run(ask('example.com', '203.0.113.3'));
    expect(again.kind).toBe('result');
    if (again.kind === 'result') expect(again.cached).toBe(false);
  });

  it('refuses a second live scan of a domain inside a day when its cached result is gone', async () => {
    const results: FreeScanner = {
      scan: async (request) => {
        const outcome = await fixtureScanner().scan(request);
        return outcome;
      },
    };
    const { service } = setup({ scanner: results, cacheMaxEntries: 1 });
    expect((await service.run(ask('a.com', '203.0.113.1'))).kind).toBe('result');
    expect((await service.run(ask('b.com', '203.0.113.1'))).kind).toBe('result');
    // a.com fell out of the one-entry cache but its day has not passed.
    const third = await service.run(ask('a.com', '203.0.113.2'));
    expect(third.kind).toBe('rate-limited');
    if (third.kind === 'rate-limited') expect(third.scope).toBe('domain');
  });

  it('says plainly that the scanner is not connected, and uses no quota for it', async () => {
    const { service } = setup({ scanner: notConnectedScanner });
    for (let i = 0; i < 6; i += 1) {
      expect(await service.run(ask(`site${i.toString()}.com`))).toEqual({
        kind: 'not-connected',
      });
    }
  });

  it('passes on a refusal to scan and gives the quota back', async () => {
    const { service } = setup({
      scanner: { scan: () => Promise.resolve({ state: 'refused', reason: 'robots' }) },
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await service.run(ask(`site${i.toString()}.com`))).toEqual({
        kind: 'refused',
        reason: 'robots',
      });
    }
  });

  it('turns a scanner exception into a generic failure and gives the quota back', async () => {
    const { service } = setup({
      scanner: { scan: () => Promise.reject(new Error('engine down')) },
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await service.run(ask(`site${i.toString()}.com`))).toEqual({ kind: 'scanner-error' });
    }
  });

  it('does not let concurrent requests slip past the cap', async () => {
    const { service } = setup();
    const outcomes = await Promise.all(
      ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map((site) => service.run(ask(site))),
    );
    expect(outcomes.filter((o) => o.kind === 'result')).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === 'rate-limited')).toHaveLength(2);
  });
});
