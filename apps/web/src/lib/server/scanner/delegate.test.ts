import { createApiClient } from '@rampsmith/contracts-ts';
import { describe, expect, it } from 'vitest';
import { apiDelegate } from './delegate.ts';
import { createFreeScanService } from './service.ts';
import { fixtureScanner } from './client.ts';

const TOKEN = 'service-token-0123456789abcdef0123456789';
const ID = '0199c0de-0000-7000-8000-000000000001';

const RESULT = {
  domain: 'shop.com',
  scanned_at: '2026-10-22T10:00:00Z',
  pages: ['https://shop.com/'],
  checks_passed: 30,
  checks_run: 34,
  failures: [
    {
      rule_id: 'image-alt',
      title: 'Images without a text alternative',
      criterion: '1.1.1',
      count: 2,
      examples: [{ page: 'https://shop.com/', snippet: '<img src="/a.jpg">' }],
    },
  ],
};

const scan = (status: string, extra: Record<string, unknown> = {}) => ({
  id: ID,
  domain: 'shop.com',
  status,
  refusal: null,
  result: null,
  cached: false,
  ...extra,
});

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** An api that answers from a script, one answer per call, and records what it was asked. */
function fakeApi(answers: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('no more answers');
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  let clock = 0;
  const delegate = apiDelegate({
    client: createApiClient('http://api.internal', fetch),
    serviceToken: TOKEN,
    waitMs: 5000,
    pollMs: 1000,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  return { delegate, seen };
}

const ask = { url: 'shop.com', ip: '203.0.113.5', token: 'widget-token' };

describe('the api delegate', () => {
  it('sends the visitor, the challenge token and the service token, and shows a finished scan', async () => {
    const { delegate, seen } = fakeApi([
      { status: 200, body: scan('complete', { result: RESULT, cached: true }) },
    ]);
    const outcome = await delegate.start(ask);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/free-scans',
        authorization: `Bearer ${TOKEN}`,
        body: { url: 'shop.com', turnstile_token: 'widget-token', client_ip: '203.0.113.5' },
      },
    ]);
    expect(outcome).toEqual({
      kind: 'result',
      cached: true,
      result: {
        domain: 'shop.com',
        scannedAt: '2026-10-22T10:00:00Z',
        pages: ['https://shop.com/'],
        checksPassed: 30,
        checksRun: 34,
        isFixture: false,
        failures: [
          {
            ruleId: 'image-alt',
            title: 'Images without a text alternative',
            criterion: '1.1.1',
            count: 2,
            examples: [{ page: 'https://shop.com/', snippet: '<img src="/a.jpg">' }],
          },
        ],
      },
    });
  });

  it('waits for a queued scan, polling until it finishes', async () => {
    const { delegate, seen } = fakeApi([
      { status: 202, body: scan('queued') },
      { status: 200, body: scan('running') },
      { status: 200, body: scan('complete', { result: RESULT }) },
    ]);
    const outcome = await delegate.start(ask);
    expect(outcome.kind).toBe('result');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /v1/free-scans',
      `GET /v1/free-scans/${ID}`,
      `GET /v1/free-scans/${ID}`,
    ]);
    expect(seen[1]?.authorization).toBe(`Bearer ${TOKEN}`);
    if (outcome.kind === 'result') expect(outcome.cached).toBe(false);
  });

  it('stops waiting at the deadline and says the scan is still running', async () => {
    const { delegate } = fakeApi([
      { status: 202, body: scan('queued') },
      ...Array.from({ length: 10 }, () => ({ status: 200, body: scan('running') })),
    ]);
    expect(await delegate.start(ask)).toEqual({ kind: 'still-running', id: ID });
  });

  it('reports a refusal and a failed scan', async () => {
    const refused = fakeApi([{ status: 200, body: scan('refused', { refusal: 'robots' }) }]);
    expect(await refused.delegate.start(ask)).toEqual({ kind: 'refused', reason: 'robots' });
    const failed = fakeApi([{ status: 200, body: scan('failed') }]);
    expect(await failed.delegate.start(ask)).toEqual({ kind: 'scanner-error' });
    const strange = fakeApi([{ status: 200, body: scan('complete', { result: { domain: 3 } }) }]);
    expect(await strange.delegate.start(ask)).toEqual({ kind: 'scanner-error' });
  });

  it('maps the api’s refusals to what the page says', async () => {
    const problem = (status: number, errors: unknown[], headers: Record<string, string> = {}) => ({
      status,
      body: { type: '/problems/x', title: 'x', status, code: 'x', errors },
      headers,
    });
    const cases: [ReturnType<typeof problem>, unknown][] = [
      [
        problem(422, [{ field: 'url', message: 'private' }]),
        { kind: 'invalid-url', reason: 'private' },
      ],
      [
        // A public suffix the api refuses (audit L1): the page says only that it is not valid.
        problem(422, [{ field: 'url', message: 'suffix' }]),
        { kind: 'invalid-url', reason: 'invalid' },
      ],
      [
        problem(422, [{ field: 'url', message: 'something new' }]),
        { kind: 'invalid-url', reason: 'invalid' },
      ],
      [
        problem(422, [{ field: 'turnstile_token', message: 'failed' }]),
        { kind: 'challenge-failed' },
      ],
      [
        problem(503, [{ field: 'turnstile_token', message: 'unavailable' }]),
        { kind: 'challenge-unavailable' },
      ],
      [problem(503, []), { kind: 'busy' }],
      [problem(503, [{ field: 'scanner', message: 'unavailable' }]), { kind: 'not-connected' }],
      [
        problem(429, [{ field: 'limit', message: 'ip' }], { 'retry-after': '3600' }),
        { kind: 'rate-limited', scope: 'ip', retryAfterSeconds: 3600 },
      ],
      [
        problem(429, [{ field: 'limit', message: 'domain' }], { 'retry-after': '7200' }),
        { kind: 'rate-limited', scope: 'domain', retryAfterSeconds: 7200 },
      ],
      [problem(401, []), { kind: 'scanner-error' }],
      [problem(500, []), { kind: 'scanner-error' }],
    ];
    for (const [answer, expected] of cases) {
      const { delegate } = fakeApi([answer]);
      expect(await delegate.start(ask)).toEqual(expected);
    }
  });

  it('treats an api that cannot be reached as a scanner error', async () => {
    const delegate = apiDelegate({
      client: createApiClient('http://api.internal', () => Promise.reject(new Error('down'))),
      serviceToken: TOKEN,
    });
    expect(await delegate.start(ask)).toEqual({ kind: 'scanner-error' });
    expect(await delegate.status(ID)).toEqual({ kind: 'scanner-error' });
  });

  it('answers a status request from one look', async () => {
    const done = fakeApi([{ status: 200, body: scan('complete', { result: RESULT }) }]);
    expect((await done.delegate.status(ID)).kind).toBe('result');
    const running = fakeApi([{ status: 200, body: scan('running') }]);
    expect(await running.delegate.status(ID)).toEqual({ kind: 'still-running', id: ID });
    const gone = fakeApi([{ status: 404, body: { code: 'not_found' } }]);
    expect(await gone.delegate.status(ID)).toEqual({ kind: 'scanner-error' });
  });
});

describe('the service with the api behind it', () => {
  it('hands the request over without local limits, cache or challenge check', async () => {
    const asked: string[] = [];
    let verified = 0;
    const service = createFreeScanService({
      scanner: fixtureScanner(),
      delegate: {
        start: ({ url }) => {
          asked.push(url);
          return Promise.resolve({ kind: 'busy' });
        },
        status: () => Promise.resolve({ kind: 'busy' }),
      },
      verifyChallenge: () => {
        verified += 1;
        return Promise.resolve({ ok: true });
      },
      now: () => 0,
    });
    // More than three scans from one address: the api, not this process, counts them.
    for (let i = 0; i < 5; i += 1) {
      expect(
        await service.run({ url: `site${String(i)}.com`, ip: '203.0.113.5', token: 't' }),
      ).toEqual({
        kind: 'busy',
      });
    }
    expect(asked).toHaveLength(5);
    expect(verified).toBe(0);
    expect(await service.status(ID)).toEqual({ kind: 'busy' });
    // An address that cannot be a public site still never leaves this process.
    expect(await service.run({ url: 'http://127.0.0.1', ip: '203.0.113.5', token: 't' })).toEqual({
      kind: 'invalid-url',
      reason: 'address',
    });
    expect(asked).toHaveLength(5);
  });

  it('has no status to give without the api', async () => {
    const service = createFreeScanService({
      scanner: fixtureScanner(),
      verifyChallenge: () => Promise.resolve({ ok: true }),
      now: () => 0,
    });
    expect(await service.status(ID)).toEqual({ kind: 'scanner-error' });
  });
});
