/**
 * Server-side Cloudflare Turnstile validation (PLAN §16).
 *
 * Checked against Cloudflare's documentation on 22 October 2026
 * (developers.cloudflare.com/turnstile/get-started/server-side-validation): POST the widget's
 * `secret` and the visitor's `response` token (optionally `remoteip`) to
 * `https://challenges.cloudflare.com/turnstile/v0/siteverify`, as form data or JSON. The reply is
 * JSON with `success` and `error-codes`. A token is at most 2048 characters, valid for 300
 * seconds and usable once; a replay fails with `timeout-or-duplicate`.
 *
 * Anything that is not a clear "yes" or a clear visitor-side failure fails closed.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 5000;

/** Error codes that mean the visitor's token was missing, wrong, expired or already used. */
const VISITOR_CODES = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
]);

export type TurnstileVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `missing`: no token was sent. `invalid`: the token failed. `unavailable`: Cloudflare could
       * not be asked, or our secret is wrong; the visitor can do nothing about it.
       */
      readonly reason: 'missing' | 'invalid' | 'unavailable';
    };

export interface VerifyTurnstileInput {
  readonly secret: string;
  readonly token: string;
  readonly remoteIp?: string | undefined;
  /** Overrides Cloudflare's origin; only the end-to-end test fake sets it. */
  readonly origin?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<TurnstileVerdict> {
  if (input.token === '') return { ok: false, reason: 'missing' };
  if (input.token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid' };

  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp !== undefined && input.remoteIp !== '') body.set('remoteip', input.remoteIp);

  const fetchImpl = input.fetch ?? globalThis.fetch;
  let payload: unknown;
  try {
    const response = await fetchImpl(
      `${input.origin ?? TURNSTILE_ORIGIN}/turnstile/v0/siteverify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (typeof payload !== 'object' || payload === null || !('success' in payload)) {
    return { ok: false, reason: 'unavailable' };
  }
  if (payload.success === true) return { ok: true };
  const codes =
    'error-codes' in payload && Array.isArray(payload['error-codes']) ? payload['error-codes'] : [];
  const visitorFault =
    codes.length > 0 && codes.every((code) => typeof code === 'string' && VISITOR_CODES.has(code));
  return { ok: false, reason: visitorFault ? 'invalid' : 'unavailable' };
}
