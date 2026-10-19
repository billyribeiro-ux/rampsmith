import type { Page } from '@playwright/test';

/**
 * The Content-Security-Policy the built app must send (audit M3, ADR-054), written out in
 * full on purpose: changing the policy means changing this object, and the reviewer sees it.
 * `frameAncestors` are the sources of the per-request `frame-ancestors` directive.
 */
export function pinnedPolicy(frameAncestors: readonly string[]): Record<string, string[]> {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", 'https://cdn.shopify.com/shopifycloud/', "'nonce-NONCE'"],
    'style-src': [
      "'self'",
      "'unsafe-inline'",
      'https://cdn.shopify.com/shopifycloud/',
      'https://cdn.shopify.com/static/fonts/',
    ],
    'img-src': ["'self'", 'data:', 'https://cdn.shopify.com/shopifycloud/'],
    'font-src': [
      "'self'",
      'https://cdn.shopify.com/shopifycloud/',
      'https://cdn.shopify.com/static/fonts/',
    ],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': [...frameAncestors],
  };
}

/**
 * A policy header as directive name to sources, with SvelteKit's per-request nonce replaced
 * so it can be compared. Directive order carries no meaning and is not compared.
 */
export function parsePolicy(header: string | undefined): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of (header ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') {
      directives[name] = sources.map((s) =>
        s.replace(/^'nonce-[A-Za-z0-9+/=_-]+'$/, "'nonce-NONCE'"),
      );
    }
  }
  return directives;
}

/**
 * Chromium reports every resource the policy blocks as a console error that names the
 * directive. The returned array fills as the page runs; a healthy page leaves it empty.
 */
export function watchPolicyViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });
  return violations;
}
