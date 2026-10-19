import { describe, expect, it, vi } from 'vitest';
import { RETRY_HEADER, sessionFetch } from './session-fetch.ts';

function bridge(...tokens: string[]) {
  const queue = [...tokens];
  return { idToken: vi.fn(() => Promise.resolve(queue.shift() ?? 'exhausted')) };
}

describe('sessionFetch', () => {
  it('sends a fresh session token as a bearer header', async () => {
    const fetchImpl = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(new Response(new Headers(init?.headers).get('authorization'))),
    );
    const response = await sessionFetch(bridge('t1'), fetchImpl, '/app/api/session', {
      method: 'POST',
    });
    expect(await response.text()).toBe('Bearer t1');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries once with a new token when the server asks for it', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(
        seen.length === 1
          ? new Response(null, { status: 401, headers: { [RETRY_HEADER]: '1' } })
          : new Response('ok'),
      );
    });
    const response = await sessionFetch(bridge('stale', 'fresh'), fetchImpl, '/x');
    expect(response.status).toBe(200);
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('does not retry a 401 without the header, nor more than once', async () => {
    const plain = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
    expect((await sessionFetch(bridge('a'), plain, '/x')).status).toBe(401);
    expect(plain).toHaveBeenCalledOnce();

    const always = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 401, headers: { [RETRY_HEADER]: '1' } })),
    );
    expect((await sessionFetch(bridge('a', 'b', 'c'), always, '/x')).status).toBe(401);
    expect(always).toHaveBeenCalledTimes(2);
  });

  it('keeps the caller headers', async () => {
    const fetchImpl = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(new Response(new Headers(init?.headers).get('accept'))),
    );
    const response = await sessionFetch(bridge('t'), fetchImpl, '/x', {
      headers: { accept: 'application/json' },
    });
    expect(await response.text()).toBe('application/json');
  });
});
