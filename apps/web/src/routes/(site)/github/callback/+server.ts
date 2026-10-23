import { redirect } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { STATE_COOKIE, finishConnection, stateOf } from '#lib/server/github-connect.ts';
import type { RequestHandler } from './$types';

/**
 * GitHub's redirect after the installation. The state is read from the cookie, spent at once
 * (the cookie is deleted whatever happens), and the api decides; this route never shows the code
 * or the installation id again and the result page carries only a word.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  const state = stateOf(cookies.get(STATE_COOKIE));
  cookies.delete(STATE_COOKIE, { path: '/github' });
  const result = await finishConnection(apiClient(API_URL), {
    state,
    echoed: url.searchParams.get('state'),
    code: url.searchParams.get('code'),
    installationId: url.searchParams.get('installation_id'),
  });
  redirect(303, `/github/connected?result=${result}`);
};
