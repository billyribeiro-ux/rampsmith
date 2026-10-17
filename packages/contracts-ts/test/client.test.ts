import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/index.ts';

const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

describe('createApiClient', () => {
  it('reads a typed readiness body', async () => {
    const client = createApiClient('http://api.internal', (input) => {
      expect(new Request(input).url).toBe('http://api.internal/readyz');
      return Promise.resolve(
        json(200, {
          status: 'ready',
          schema_version: 20261017000004,
          expected_schema_version: 20261017000004,
        }),
      );
    });
    const { data, error } = await client.GET('/readyz');
    expect(error).toBeUndefined();
    expect(data?.schema_version).toBe(20261017000004);
  });

  it('surfaces problem+json errors with their stable code', async () => {
    const client = createApiClient('http://api.internal', () =>
      Promise.resolve(
        json(
          503,
          {
            type: '/problems/unavailable',
            title: 'Service unavailable',
            status: 503,
            code: 'unavailable',
          },
          'application/problem+json',
        ),
      ),
    );
    const { data, error } = await client.GET('/readyz');
    expect(data).toBeUndefined();
    expect(error).toMatchObject({ code: 'unavailable', status: 503 });
  });
});
