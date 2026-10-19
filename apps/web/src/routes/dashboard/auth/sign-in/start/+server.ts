import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { startSignIn } from '#lib/server/dashboard.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = () => startSignIn(apiClient(API_URL));
