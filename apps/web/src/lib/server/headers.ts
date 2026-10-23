/**
 * Security headers on every response (PLAN §18). The fetch directives come from SvelteKit's
 * `csp` option (`headers-policy.ts`, ADR-054) with per-request nonces; this adds
 * `frame-ancestors`, which must name the shop for embedded routes and forbid framing
 * everywhere else (ADR-023).
 */
import { frameAncestors } from '../shopify/frame.ts';

const EMBEDDED = /^\/app(\/|$)/;
const DASHBOARD = /^\/dashboard(\/|$)/;
/**
 * The pages behind email links: their address is a secret (ADR-274), so no other site may see it
 * in a Referer. `same-origin` and not `no-referrer`: with `no-referrer` a browser sends
 * `Origin: null` on a form post, which SvelteKit's CSRF check rightly refuses.
 */
const EMAIL_LINK = /^\/email(\/|$)/;

export function securityHeaders(url: URL, headers: Headers): void {
  const framing = EMBEDDED.test(url.pathname) ? frameAncestors(url) : "frame-ancestors 'none'";
  const csp = headers.get('content-security-policy');
  headers.set(
    'content-security-policy',
    csp === null || csp === '' ? framing : `${csp}; ${framing}`,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set(
    'referrer-policy',
    EMAIL_LINK.test(url.pathname) ? 'same-origin' : 'strict-origin-when-cross-origin',
  );
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (EMAIL_LINK.test(url.pathname)) {
    // Not cached and not indexed. Set here and not with `setHeaders`: a load and an action both
    // setting a header on one request is an error in SvelteKit.
    headers.set('cache-control', 'private, no-store');
    headers.set('x-robots-tag', 'noindex, nofollow');
  }
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
