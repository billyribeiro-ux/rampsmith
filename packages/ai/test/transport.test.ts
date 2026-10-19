/**
 * The SDK-backed transport against a fake `fetch` that serves the documented HTTP responses,
 * so the real SDK builds every request and parses every response and error.
 */
import { describe, expect, it } from 'vitest';
import { AiError } from '../src/errors.ts';
import { classifyError, createAnthropicTransport, parseRetryAfter } from '../src/transport.ts';
import { message } from './fakes.ts';

const KEY = 'sk-ant-test-0000000000000000';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const s = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    seen.push(s);
    return respond(s);
  };
  return { seen, fetch: impl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_011Test', ...headers },
  });

const apiError = (type: string, msg: string, details?: unknown) => ({
  type: 'error',
  error: { type, message: msg, ...(details === undefined ? {} : { details }) },
  request_id: 'req_011Test',
});

const params = {
  model: 'claude-haiku-5-5',
  max_tokens: 400,
  messages: [{ role: 'user' as const, content: 'Describe this.' }],
};

describe('createAnthropicTransport', () => {
  it('sends the Messages API request with the key header and returns the request id', async () => {
    const f = fakeFetch(() => json(200, message({ ok: true })));
    const t = createAnthropicTransport({ apiKey: KEY, fetch: f.fetch });
    const r = await t.createMessage(params, { timeoutMs: 5000 });
    expect(r.requestId).toBe('req_011Test');
    expect(r.message.content[0]).toMatchObject({ type: 'text' });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.method).toBe('POST');
    expect(f.seen[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(f.seen[0]?.headers.get('x-api-key')).toBe(KEY);
    expect(f.seen[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(f.seen[0]?.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 400 });
  });

  it.each([
    [
      429,
      apiError('rate_limit_error', 'Number of requests has exceeded your rate limit'),
      { 'retry-after': '3' },
      'ai_rate_limited',
      3000,
    ],
    [
      429,
      apiError('rate_limit_error', 'You have reached your API usage limits', {
        error_code: 'enforced_spend_limit_reached',
      }),
      {},
      'ai_spend_limit',
      undefined,
    ],
    [
      400,
      apiError(
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-11-01',
      ),
      {},
      'ai_spend_limit',
      undefined,
    ],
    [
      400,
      apiError('invalid_request_error', 'messages.0: bad'),
      {},
      'ai_invalid_request',
      undefined,
    ],
    [401, apiError('authentication_error', 'invalid x-api-key'), {}, 'ai_auth', undefined],
    [403, apiError('permission_error', 'no access'), {}, 'ai_auth', undefined],
    [402, apiError('billing_error', 'payment'), {}, 'ai_spend_limit', undefined],
    [404, apiError('not_found_error', 'no such model'), {}, 'ai_invalid_request', undefined],
    [413, apiError('request_too_large', 'too big'), {}, 'ai_request_too_large', undefined],
    [500, apiError('api_error', 'oops'), {}, 'ai_server_error', undefined],
    [504, apiError('timeout_error', 'slow'), {}, 'ai_timeout', undefined],
    [529, apiError('overloaded_error', 'Overloaded'), {}, 'ai_overloaded', undefined],
  ])(
    'maps HTTP %i to an AiError without retrying in the SDK',
    async (status, body, headers, code, retryAfterMs) => {
      const f = fakeFetch(() => json(status, body, headers));
      const t = createAnthropicTransport({ apiKey: KEY, fetch: f.fetch });
      const error = await t.createMessage(params, { timeoutMs: 5000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiError);
      expect(error).toMatchObject({ code, status, requestId: 'req_011Test', retryAfterMs });
      expect(f.seen).toHaveLength(1);
      expect((error as AiError).message).not.toContain(KEY);
      expect((error as AiError).message).not.toContain(
        (body as { error: { message: string } }).error.message,
      );
    },
  );

  it('maps a network failure to ai_connection', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const t = createAnthropicTransport({ apiKey: KEY, fetch: f.fetch });
    await expect(t.createMessage(params, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'ai_connection',
    });
  });

  it('maps an aborted call to ai_aborted', async () => {
    const f = fakeFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            reject(new DOMException('aborted', 'AbortError'));
          }, 50);
        }),
    );
    const t = createAnthropicTransport({ apiKey: KEY, fetch: f.fetch });
    const controller = new AbortController();
    const pending = t.createMessage(params, { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ai_aborted' });
  });

  it('refuses an empty key without calling the API', () => {
    expect(() => createAnthropicTransport({ apiKey: ' ' })).toThrow(
      expect.objectContaining({ code: 'ai_auth' }),
    );
  });

  it('creates, retrieves, reads and deletes a batch', async () => {
    const batch = {
      id: 'msgbatch_01Test',
      type: 'message_batch',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1 },
      ended_at: '2026-10-17T13:00:00Z',
      created_at: '2026-10-17T12:00:00Z',
      expires_at: '2026-10-18T12:00:00Z',
      archived_at: null,
      cancel_initiated_at: null,
      results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_01Test/results',
    };
    const jsonl = [
      { custom_id: 'a', result: { type: 'succeeded', message: message({ ok: 1 }) } },
      {
        custom_id: 'b',
        result: {
          type: 'errored',
          error: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } },
        },
      },
      { custom_id: 'c', result: { type: 'expired' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const f = fakeFetch((s) => {
      if (s.method === 'POST' && s.url.endsWith('/v1/messages/batches'))
        return json(200, { ...batch, processing_status: 'in_progress' });
      if (s.method === 'GET' && s.url.endsWith('/results')) {
        return new Response(jsonl, {
          status: 200,
          headers: { 'content-type': 'application/binary' },
        });
      }
      if (s.method === 'GET') return json(200, batch);
      if (s.method === 'DELETE') return json(200, { id: batch.id, type: 'message_batch_deleted' });
      return json(404, apiError('not_found_error', 'x'));
    });
    const t = createAnthropicTransport({ apiKey: KEY, fetch: f.fetch });
    const created = await t.createBatch([{ custom_id: 'a', params }], { timeoutMs: 5000 });
    expect(created.id).toBe('msgbatch_01Test');
    expect(f.seen[0]?.body).toEqual({ requests: [{ custom_id: 'a', params }] });
    const status = await t.retrieveBatch(created.id, { timeoutMs: 5000 });
    expect(status).toMatchObject({
      processingStatus: 'ended',
      counts: { succeeded: 1, expired: 1 },
    });
    const results = [];
    for await (const r of t.batchResults(created.id, { timeoutMs: 5000 })) {
      results.push(r);
    }
    expect(results.map((r) => [r.customId, r.type])).toEqual([
      ['a', 'succeeded'],
      ['b', 'errored'],
      ['c', 'expired'],
    ]);
    expect(results[1]).toMatchObject({ errorType: 'invalid_request_error' });
    await t.deleteBatch(created.id, { timeoutMs: 5000 });
    expect(f.seen.at(-1)?.method).toBe('DELETE');
  });
});

describe('parseRetryAfter and classifyError', () => {
  it('reads seconds, milliseconds and HTTP dates', () => {
    const now = Date.UTC(2026, 9, 17, 12, 0, 0);
    expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }), now)).toBe(1500);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }), now)).toBe(250);
    expect(
      parseRetryAfter(new Headers({ 'retry-after': 'Sat, 17 Oct 2026 12:00:10 GMT' }), now),
    ).toBe(10_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });

  it('passes AiErrors through and wraps timeouts from AbortSignal.timeout', () => {
    const e = new AiError('ai_refused', 'x');
    expect(classifyError(e)).toBe(e);
    expect(classifyError(new DOMException('t', 'TimeoutError')).code).toBe('ai_timeout');
  });
});
