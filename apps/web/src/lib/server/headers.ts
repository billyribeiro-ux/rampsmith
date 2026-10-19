/**
 * Security headers on every response (PLAN §18). The fetch directives come from SvelteKit's
 * `csp` option (`headers-policy.ts`, ADR-054) with per-request nonces; this adds
 * `frame-ancestors`, which must name the shop for embedded routes and forbid framing
 * everywhere else (ADR-023).
 */
import { frameAncestors } from '../shopify/frame.ts';

const EMBEDDED = /^\/app(\/|$)/;
const DASHBOARD = /^\/dashboard(\/|$)/;

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
  if (DASHBOARD.test(url.pathname)) {
    // Dashboard pages hold the signed-in user's name and email, and what they show depends on
    // the session cookie. No shared cache may store them, and the browser must not keep them for
    // its back button after sign-out (audit L8, ADR-055).
    headers.set('cache-control', 'private, no-store');
  }
  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}
