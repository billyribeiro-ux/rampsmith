import { createHash } from 'node:crypto';
import { API_URL } from '$app/env/private';
import { fetchMedia, mediaUrl } from '#lib/app/media.server.ts';
import { MediaGuard } from '#lib/app/media-guard.server.ts';
import { bearer, problem, unauthenticated, upstream } from '#lib/app/upstream.server.ts';
import type { RequestHandler } from './$types';

const VERIFIED_FOR_MS = 30_000;
const MAX_VERIFIED = 500;
/** Token hashes the api accepted lately, so a page of thumbnails costs one check, not forty. */
const verified = new Map<string, number>();
/** Rate and concurrency limits for the route (security audit L4, ADR-099). */
const guard = new MediaGuard();

function remember(key: string, now: number): void {
  if (verified.size >= MAX_VERIFIED) {
    for (const [k, until] of verified) if (until <= now) verified.delete(k);
    if (verified.size >= MAX_VERIFIED) verified.clear();
  }
  verified.set(key, now + VERIFIED_FOR_MS);
}

/** Returns a product image from Shopify's CDN to a signed-in visitor (ADR-092). */
export const GET: RequestHandler = async ({ request, url, getClientAddress }) => {
  const authorization = bearer(request);
  if (authorization === undefined) return unauthenticated();
  const target = mediaUrl(url.searchParams.get('u'));
  if (target === undefined) return problem(400, 'bad_request', 'Not an allowed image address');

  // The session token is verified by the api: only a signed-in shop may use this route.
  const key = createHash('sha256').update(authorization).digest('hex');
  // Before anything costs an api call or a CDN fetch: a limit per token and per address.
  let address = 'unknown';
  try {
    address = getClientAddress();
  } catch {
    // No address behind this deployment: the token key still applies.
  }
  const entry = guard.enter(key, address);
  if (!entry.ok) {
    const limited = problem(429, 'rate_limited', 'Too many image requests');
    limited.headers.set('retry-after', String(entry.retryAfterSeconds));
    return limited;
  }
  try {
    return await serve(authorization, key, target);
  } finally {
    entry.release();
  }
};

async function serve(authorization: string, key: string, target: URL): Promise<Response> {
  const now = Date.now();
  if ((verified.get(key) ?? 0) <= now) {
    let check: Response;
    try {
      check = await upstream(API_URL, authorization).call('overview');
    } catch {
      return problem(503, 'unavailable', 'Service unavailable');
    }
    await check.body?.cancel();
    if (!check.ok) {
      const unauthorised = check.status === 401;
      return problem(unauthorised ? 401 : 403, 'unauthenticated', 'Not allowed', {
        retry: unauthorised,
      });
    }
    remember(key, now);
  }

  const result = await fetchMedia(target);
  if (!result.ok) return problem(result.status, 'media_unavailable', 'Image unavailable');
  return new Response(new Blob([result.bytes], { type: result.type }), {
    headers: {
      'content-type': result.type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
