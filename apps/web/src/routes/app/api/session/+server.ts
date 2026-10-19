import { API_URL } from '$app/env/private';
import { apiClient } from '#lib/server/api.ts';
import { forwardSession } from '#lib/server/shopify-session.ts';
import type { RequestHandler } from './$types';

/** Starts the embedded app's session: forwards the App Bridge token to the api. */
export const POST: RequestHandler = ({ request }) =>
  forwardSession(apiClient(API_URL), request.headers.get('authorization'));
