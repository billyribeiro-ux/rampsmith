import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { apiClient } from './api.ts';
import {
  SESSION_COOKIE,
  clearSession,
  currentUser,
  finishCeremony,
  signOut,
  startRegistration,
  startSignIn,
} from './dashboard.ts';

const API = 'http://api.internal:8080';
const USER = {
  id: '0192f0c6-0000-7000-8000-000000000001',
  email: 'ada@example.com',
  display_name: 'Ada',
};

function api(handler: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const client = apiClient(API, (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return Promise.resolve(handler(request));
  });
  return { client, seen };
}

function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const set = vi.fn<(name: string, value: string, options: Record<string, unknown>) => void>(
    (name, value) => {
      values.set(name, value);
    },
  );
  const del = vi.fn<(name: string, options: Record<string, unknown>) => void>((name) => {
    values.delete(name);
  });
  const cookies = {
    get: (name: string) => values.get(name),
    set,
    delete: del,
  } as unknown as Cookies;
  return { cookies, set, del, values };
}

describe('currentUser', () => {
  it('forwards the token as a Session authorization and returns the user', async () => {
    const { client, seen } = api(() => Response.json({ user: USER }));
    expect(await currentUser(client, 'tok')).toEqual(USER);
    expect(seen[0]?.url).toBe(`${API}/v1/auth/session`);
    expect(seen[0]?.headers.get('authorization')).toBe('Session tok');
  });

  it('is undefined without a token, for an ended session, or when the api is down', async () => {
    const { client, seen } = api(() => new Response(null, { status: 401 }));
    expect(await currentUser(client, undefined)).toBeUndefined();
    expect(seen).toHaveLength(0);
    expect(await currentUser(client, 'old')).toBeUndefined();
    const down = apiClient(API, () => Promise.reject(new TypeError('fetch failed')));
    expect(await currentUser(down, 'tok')).toBeUndefined();
  });
});

describe('finishCeremony', () => {
  const answer = { ceremony_id: '0192f0c6-0000-7000-8000-0000000000aa', credential: { id: 'x' } };

  it('keeps the token in an HttpOnly cookie and returns only the user', async () => {
    const expires = '2026-11-16T12:00:00Z';
    const { client, seen } = api(() =>
      Response.json({ token: 'secret-token', expires_at: expires, user: USER }, { status: 201 }),
    );
    const jar = cookieJar();
    const response = await finishCeremony(client, 'sign-in', answer, jar.cookies);
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain('secret-token');
    expect(JSON.parse(body)).toEqual({ user: USER });
    expect(seen[0]?.url).toBe(`${API}/v1/auth/sign-in/finish`);
    expect(await seen[0]?.json()).toEqual(answer);
    expect(jar.set).toHaveBeenCalledWith(SESSION_COOKIE, 'secret-token', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expires: new Date(expires),
    });
  });

  it('sets a cookie a browser accepts under the __Host- prefix, whatever the request scheme', async () => {
    // The prefix needs Secure, Path=/ and no Domain (audit L8, ADR-055); a cookie that breaks
    // any rule is dropped by the browser and the user is never signed in.
    const { client } = api(() =>
      Response.json(
        { token: 't', expires_at: '2026-11-16T12:00:00Z', user: USER },
        { status: 201 },
      ),
    );
    const jar = cookieJar();
    await finishCeremony(client, 'register', answer, jar.cookies);
    expect(SESSION_COOKIE).toBe('__Host-rs_session');
    const options = jar.set.mock.calls[0]?.[2];
    expect(options).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'lax' });
    expect(options).not.toHaveProperty('domain');
  });

  it('relays a verification failure without setting a cookie', async () => {
    const { client } = api(
      () =>
        new Response(
          JSON.stringify({
            status: 400,
            code: 'bad_request',
            title: 'Bad request',
            type: 'about:blank',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );
    const jar = cookieJar();
    const response = await finishCeremony(client, 'register', answer, jar.cookies);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'bad_request' });
    expect(jar.set).not.toHaveBeenCalled();
  });

  it('refuses malformed bodies before calling the api', async () => {
    const { client, seen } = api(() => new Response());
    for (const body of [
      null,
      {},
      { ceremony_id: 1, credential: {} },
      { ceremony_id: 'x', credential: 'y' },
    ]) {
      const response = await finishCeremony(client, 'register', body, cookieJar().cookies);
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('ceremony starts', () => {
  it('pass the options through', async () => {
    const started = { ceremony_id: 'c', options: { publicKey: { challenge: 'abc' } } };
    const { client, seen } = api(() => Response.json(started));
    const response = await startRegistration(client, {
      email: 'ada@example.com',
      display_name: 'Ada',
    });
    expect(await response.json()).toEqual(started);
    expect(await seen[0]?.json()).toEqual({ email: 'ada@example.com', display_name: 'Ada' });
    expect(await (await startSignIn(client)).json()).toEqual(started);
  });

  it('validate the registration body', async () => {
    const { client, seen } = api(() => new Response());
    expect((await startRegistration(client, { email: 'x' })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('answer 503 when the api is down', async () => {
    const down = apiClient(API, () => Promise.reject(new TypeError('fetch failed')));
    expect((await startSignIn(down)).status).toBe(503);
  });
});

describe('signOut', () => {
  it('ends the api session and clears the cookie', async () => {
    const { client, seen } = api(() => new Response(null, { status: 204 }));
    const jar = cookieJar({ [SESSION_COOKIE]: 'tok' });
    await signOut(client, jar.cookies);
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.headers.get('authorization')).toBe('Session tok');
    expect(jar.del).toHaveBeenCalledWith(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('clears the cookie even without one, with the attributes the prefix needs', async () => {
    // A `Set-Cookie` for a `__Host-` name that lacks Secure is ignored, so a bare
    // `delete(name, { path: '/' })` on http://localhost would leave the session in the browser.
    const { client, seen } = api(() => new Response(null, { status: 204 }));
    const jar = cookieJar();
    await signOut(client, jar.cookies);
    expect(seen).toHaveLength(0);
    expect(jar.del).toHaveBeenCalledTimes(1);
    const options = jar.del.mock.calls[0]?.[1];
    expect(options).toMatchObject({ secure: true, path: '/' });
    expect(options).not.toHaveProperty('domain');
  });
});

describe('clearSession', () => {
  it('deletes the session cookie with the same attributes it was set with', () => {
    const jar = cookieJar({ [SESSION_COOKIE]: 'tok' });
    clearSession(jar.cookies);
    expect(jar.del).toHaveBeenCalledWith(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });
});
