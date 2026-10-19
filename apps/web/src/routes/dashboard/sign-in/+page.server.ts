import { redirect } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { SESSION_COOKIE, currentUser } from '#lib/server/dashboard.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
  if ((await currentUser(apiClient(API_URL), cookies.get(SESSION_COOKIE))) !== undefined) {
    redirect(303, '/dashboard');
  }
};
