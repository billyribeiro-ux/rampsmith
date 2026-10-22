/**
 * Cloudflare Turnstile needs two things from the page's Content-Security-Policy, and only on the
 * scanner page (Cloudflare, "Content Security Policy", checked 22 October 2026): the widget's
 * origin in `script-src`, and the same origin in `frame-src`. Every other page keeps the pinned
 * policy from `headers-policy.ts` (ADR-054, ADR-261).
 */
import type { Handle } from '@sveltejs/kit/hooks';

const SCANNER = /^\/scan(\/|$)/u;

export const isScannerPath = (pathname: string): boolean => SCANNER.test(pathname);

/** `policy` with `origin` allowed to script and frame. */
export function allowTurnstile(policy: string, origin: string): string {
  if (policy.trim() === '') return policy;
  const directives = policy.split(';').map((part) => part.trim());
  const hasFrame = directives.some((directive) => /^frame-src(\s|$)/u.test(directive));
  const extended = directives.map((directive) => {
    const [name = '', ...sources] = directive.split(/\s+/u);
    if (name !== 'script-src' && name !== 'frame-src') return directive;
    return sources.includes(origin) ? directive : `${directive} ${origin}`;
  });
  if (!hasFrame) extended.push(`frame-src ${origin}`);
  return extended.join('; ');
}

/** A request handler that applies `allowTurnstile` to the scanner page's response. */
export function turnstileCsp(origin: string): Handle {
  return async ({ event, resolve }) => {
    const response = await resolve(event);
    if (isScannerPath(event.url.pathname)) {
      const csp = response.headers.get('content-security-policy');
      if (csp !== null) {
        response.headers.set('content-security-policy', allowTurnstile(csp, origin));
      }
    }
    return response;
  };
}
