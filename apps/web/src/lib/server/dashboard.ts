/**
 * The standalone dashboard's session, held by `web` for the browser (PLAN §16, ADR-024).
 * The api's session token lives only in the `rs_session` cookie (`HttpOnly`, `Secure`,
 * `SameSite=Lax`) and is forwarded as `Authorization: Session <token>`; the browser's scripts
 * never see it. WebAuthn options and responses pass through unchanged.
 */
import type { Cookies } from '@sveltejs/kit';
import type { ApiClient } from '@rampsmith/contracts-ts';

export const SESSION_COOKIE = 'rs_session';

/** A signed-in dashboard user. */
export interface DashboardUser {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

function problem(status: number, code: string, title: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title, status, code }), {
    status,
    headers: { ...NO_STORE, 'content-type': 'application/problem+json' },
  });
}

function relayError(error: unknown, status: number): Response {
  return new Response(JSON.stringify(error), {
    status,
    headers: { ...NO_STORE, 'content-type': 'application/problem+json' },
  });
}

const unavailable = () => problem(503, 'unavailable', 'Service unavailable');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The signed-in user for a session token, or `undefined` when there is none or it ended. */
export async function currentUser(
  client: ApiClient,
  token: string | undefined,
): Promise<DashboardUser | undefined> {
  if (token === undefined || token === '') return undefined;
  const result = await client
    .GET('/v1/auth/session', { headers: { authorization: `Session ${token}` } })
    .catch(() => undefined);
  return result?.data?.user;
}

/** Ends the session at the api and clears the cookie. */
export async function signOut(client: ApiClient, cookies: Cookies): Promise<void> {
  const token = cookies.get(SESSION_COOKIE);
  if (token !== undefined) {
    await client
      .DELETE('/v1/auth/session', { headers: { authorization: `Session ${token}` } })
      .catch(() => undefined);
  }
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** `POST /dashboard/auth/register/start`. */
export async function startRegistration(client: ApiClient, body: unknown): Promise<Response> {
  if (
    !isRecord(body) ||
    typeof body['email'] !== 'string' ||
    typeof body['display_name'] !== 'string'
  ) {
    return problem(400, 'bad_request', 'Bad request');
  }
  const result = await client
    .POST('/v1/auth/register/start', {
      body: { email: body['email'], display_name: body['display_name'] },
    })
    .catch(() => undefined);
  if (result === undefined) return unavailable();
  return result.data === undefined
    ? relayError(result.error, result.response.status)
    : Response.json(result.data, { headers: NO_STORE });
}

/** `POST /dashboard/auth/sign-in/start`. */
export async function startSignIn(client: ApiClient): Promise<Response> {
  const result = await client.POST('/v1/auth/sign-in/start').catch(() => undefined);
  if (result === undefined) return unavailable();
  return result.data === undefined
    ? relayError(result.error, result.response.status)
    : Response.json(result.data, { headers: NO_STORE });
}

function ceremonyResponse(body: unknown): { ceremony_id: string; credential: object } | undefined {
  return isRecord(body) && typeof body['ceremony_id'] === 'string' && isRecord(body['credential'])
    ? { ceremony_id: body['ceremony_id'], credential: body['credential'] }
    : undefined;
}

/**
 * `POST /dashboard/auth/{register,sign-in}/finish`: completes the ceremony and, on success,
 * stores the session token in the cookie. The browser receives only the user.
 */
export async function finishCeremony(
  client: ApiClient,
  kind: 'register' | 'sign-in',
  body: unknown,
  cookies: Cookies,
  secure: boolean,
): Promise<Response> {
  const answer = ceremonyResponse(body);
  if (answer === undefined) return problem(400, 'bad_request', 'Bad request');
  const path = kind === 'register' ? '/v1/auth/register/finish' : '/v1/auth/sign-in/finish';
  const result = await client.POST(path, { body: answer }).catch(() => undefined);
  if (result === undefined) return unavailable();
  if (result.data === undefined) return relayError(result.error, result.response.status);
  cookies.set(SESSION_COOKIE, result.data.token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    expires: new Date(result.data.expires_at),
  });
  return Response.json({ user: result.data.user }, { status: 201, headers: NO_STORE });
}
