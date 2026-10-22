import { API_URL } from '$app/env/private';
import { forward } from '#lib/app/proxy.server.ts';
import type { RequestHandler } from './$types';

/** The App Home's window onto the api's `/v1/shopify/` operations (ADR-091). */
const handle: RequestHandler = ({ request, params }) => forward(API_URL, request, params.path);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
