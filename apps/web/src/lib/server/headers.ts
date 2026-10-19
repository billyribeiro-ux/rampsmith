/**
 * Security headers on every response (PLAN §18). The fetch directives come from SvelteKit's
 * `csp` option (`headers-policy.ts`, ADR-054) with per-request nonces; this adds
 * `frame-ancestors`, which must name the shop for embedded routes and forbid framing
 * everywhere else (ADR-023).
 */
import { frameAncestors } from '../shopify/frame.ts';

const EMBEDDED = /^\/app(\/|$)/;

export function securityHeaders(url: URL, headers: Headers): void {
  const framing = EMBEDDED.test(url.pathname) ? frameAncestors(url) : "frame-ancestors 'none'";
  const csp = headers.get('content-security-policy');
  headers.set(
    'content-security-policy',
    csp === null || csp === '' ? framing : `${csp}; ${framing}`,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}
