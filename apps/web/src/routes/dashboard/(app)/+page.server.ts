import { redirect } from '@sveltejs/kit';
import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { signOut } from '#lib/server/dashboard.ts';
import type { Actions } from './$types';

export const actions: Actions = {
  signOut: async ({ cookies }) => {
    await signOut(apiClient(API_URL), cookies);
    redirect(303, '/dashboard/sign-in');
  },
};
