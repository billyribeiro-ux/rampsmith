import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { finishCeremony } from '#lib/server/dashboard.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) =>
  finishCeremony(
    apiClient(API_URL),
    'sign-in',
    await request.json().catch(() => undefined),
    cookies,
  );
