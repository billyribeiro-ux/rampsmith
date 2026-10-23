import { redirect } from '@sveltejs/kit';
import { GITHUB_APP_SLUG } from '$app/env/private';
import {
  STATE_COOKIE,
  STATE_MAX_AGE_SECONDS,
  installationUrl,
  stateOf,
} from '#lib/server/github-connect.ts';
import type { RequestHandler } from './$types';

/**
 * Opened in a new tab by App Home with the one-time state the api issued. The state goes into an
 * `HttpOnly` cookie, so the callback can show it is the same browser, and on to GitHub's
 * installation page.
 */
export const GET: RequestHandler = ({ url, cookies }) => {
  const state = stateOf(url.searchParams.get('state'));
  const target = state === undefined ? undefined : installationUrl(GITHUB_APP_SLUG, state);
  if (state === undefined || target === undefined) {
    redirect(303, '/github/connected?result=unavailable');
  }
  cookies.set(STATE_COOKIE, state, {
    path: '/github',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  redirect(303, target, { external: ['https://github.com'] });
};
