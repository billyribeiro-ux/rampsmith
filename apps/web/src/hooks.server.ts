import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { sequence } from '@sveltejs/kit/hooks';
import { TURNSTILE_ORIGIN } from '$app/env/private';
import { paraglideMiddleware } from '#lib/paraglide/server.js';
import { securityHeaders } from '#lib/server/headers.ts';
import { turnstileCsp } from '#lib/server/scanner/csp.ts';

const i18n: Handle = ({ event, resolve }) =>
  // Only the base-locale strategy is configured, so the request is never rewritten.
  paraglideMiddleware(event.request, ({ locale }) =>
    resolve(event, {
      transformPageChunk: ({ html }) => html.replace('%paraglide.lang%', locale),
    }),
  );

const headers: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  securityHeaders(event.url, response.headers);
  return response;
};

// The scanner page alone also lets Cloudflare's Turnstile widget script and frame in (ADR-261);
// it runs inside `headers`, so frame-ancestors is still appended last.
export const handle = sequence(i18n, headers, turnstileCsp(TURNSTILE_ORIGIN));

/** Unknown errors get a reference to quote; their details stay in the server's span. */
export const handleError: HandleServerError = ({ kind, error, event }) => {
  if (kind === 'app' || kind === 'framework' || kind === 'validation') {
    return error;
  }
  const reference = crypto.randomUUID();
  event.tracing.current.setAttribute('rampsmith.error_reference', reference);
  event.tracing.current.recordException(error instanceof Error ? error : String(error));
  return { message: 'Internal Error', reference };
};
