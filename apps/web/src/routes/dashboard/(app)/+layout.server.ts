import { redirect } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { SESSION_COOKIE, clearSession, currentUser } from '#lib/server/dashboard.ts';
import type { LayoutServerLoad } from './$types';

/** Every dashboard page needs a live session; otherwise, sign in. */
export const load: LayoutServerLoad = async ({ cookies }) => {
  const user = await currentUser(apiClient(API_URL), cookies.get(SESSION_COOKIE));
  if (user === undefined) {
    clearSession(cookies);
    redirect(303, '/dashboard/sign-in');
  }
  return { user };
};
