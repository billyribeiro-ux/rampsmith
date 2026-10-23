import { describe, expect, it } from 'vitest';
import type { ApiClient } from '@rampsmith/contracts-ts';
import { categoryOf, changeLink, inspectLink, wellFormed } from './email-link.ts';

function client(status: number, data: unknown): { client: ApiClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const fake = {
    POST: (path: string, init: unknown) => {
      calls.push([path, init]);
      return Promise.resolve({ response: { status }, data });
    },
  };
  return { client: fake as unknown as ApiClient, calls };
}

describe('email links', () => {
  it('only passes tokens that look like ours to the api', async () => {
    const { client: c, calls } = client(200, { status: 'ok' });
    for (const bad of ['', 'a b', '../x', 'x'.repeat(401), undefined, 5]) {
      expect(await inspectLink(c, bad)).toEqual({ status: 'invalid' });
    }
    expect(calls).toEqual([]);
    expect(wellFormed('abc_DEF-123')).toBe('abc_DEF-123');
  });

  it('reads the api answer and refuses an answer it does not understand', async () => {
    const ok = {
      status: 'ok',
      purpose: 'unsubscribe',
      categories: [{ category: 'notification', enabled: true }],
    };
    expect(await inspectLink(client(200, ok).client, 'tok')).toEqual({
      status: 'ok',
      purpose: 'unsubscribe',
      categories: [{ category: 'notification', enabled: true }],
    });
    expect(await inspectLink(client(200, { status: 'expired' }).client, 'tok')).toEqual({
      status: 'expired',
    });
    expect(await inspectLink(client(200, { status: 'invalid' }).client, 'tok')).toEqual({
      status: 'invalid',
    });
    expect(await inspectLink(client(503, null).client, 'tok')).toEqual({ status: 'unavailable' });
    expect(
      await inspectLink(client(200, { status: 'ok', purpose: 'x', categories: [] }).client, 'tok'),
    ).toEqual({ status: 'unavailable' });
  });

  it('sends the change with the token, the category and the choice', async () => {
    const { client: c, calls } = client(200, { status: 'invalid' });
    await changeLink(c, 'tok', 'notification', false);
    expect(calls).toEqual([
      [
        '/v1/email/links/preference',
        { body: { token: 'tok', category: 'notification', enabled: false } },
      ],
    ]);
    expect(categoryOf('security')).toBeUndefined();
    expect(categoryOf('marketing')).toBe('marketing');
  });

  it('treats an unreachable api as unavailable, not as a bad link', async () => {
    const down = {
      POST: () => Promise.reject(new Error('down')),
    } as unknown as ApiClient;
    expect(await inspectLink(down, 'tok')).toEqual({ status: 'unavailable' });
    expect(await changeLink(down, 'tok', 'marketing', true)).toEqual({ status: 'unavailable' });
  });
});
