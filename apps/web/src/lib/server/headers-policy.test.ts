/**
 * Audit M3 (ADR-054): the script policy allows Shopify's script directory, not the whole of
 * cdn.shopify.com, which also serves files merchants upload. The built app's real header is
 * pinned in tests/app.spec.ts and tests/dashboard.spec.ts; this pins what is configured.
 */
import { describe, expect, it } from 'vitest';
import { SHOPIFY_FONTS, SHOPIFY_SCRIPTS, contentSecurityPolicy } from './headers-policy.ts';

const { directives } = contentSecurityPolicy;
const entries: [string, readonly string[]][] = Object.entries(directives);

/** The path-less form of every host source, such as `https://cdn.shopify.com`. */
function bareHosts(sources: readonly string[]): string[] {
  return sources.filter((source) => /^https?:\/\/[^/]+\/?$/.test(source));
}

describe('contentSecurityPolicy', () => {
  it('uses nonces, and hashes for prerendered pages, for SvelteKit inline scripts', () => {
    expect(contentSecurityPolicy.mode).toBe('auto');
  });

  it("allows only Shopify's script directory, never the whole CDN host", () => {
    expect(SHOPIFY_SCRIPTS).toBe('https://cdn.shopify.com/shopifycloud/');
    expect(SHOPIFY_FONTS).toBe('https://cdn.shopify.com/static/fonts/');
    expect(directives['script-src']).toEqual(['self', 'https://cdn.shopify.com/shopifycloud/']);
    for (const [name, sources] of entries) {
      expect(bareHosts(sources), name).toEqual([]);
      expect(sources, name).not.toContain('https:');
      expect(sources, name).not.toContain('*');
    }
  });

  it('keeps every host source to a directory, so only paths under it match', () => {
    for (const [name, sources] of entries) {
      for (const source of sources.filter((s) => s.startsWith('https://'))) {
        expect(source, name).toMatch(/\/$/);
      }
    }
  });

  it('runs no inline script or eval: scripts need a nonce', () => {
    for (const forbidden of ['unsafe-inline', 'unsafe-eval', 'unsafe-hashes', 'strict-dynamic']) {
      expect(directives['script-src'], forbidden).not.toContain(forbidden);
    }
    expect(directives['default-src']).toEqual(['self']);
  });

  it('names every fetch directive the pages need, so nothing falls back to a wide default', () => {
    expect(directives['default-src']).toEqual(['self']);
    expect(directives['connect-src']).toEqual(['self']);
    expect(directives['img-src']).toEqual(['self', 'data:', SHOPIFY_SCRIPTS]);
    expect(directives['font-src']).toEqual(['self', SHOPIFY_SCRIPTS, SHOPIFY_FONTS]);
    expect(directives['style-src']).toEqual([
      'self',
      'unsafe-inline',
      SHOPIFY_SCRIPTS,
      SHOPIFY_FONTS,
    ]);
    expect(directives['object-src']).toEqual(['none']);
    expect(directives['base-uri']).toEqual(['self']);
    expect(directives['form-action']).toEqual(['self']);
  });

  it('leaves frame-ancestors to the per-request header, where the shop is known', () => {
    expect(Object.keys(directives)).not.toContain('frame-ancestors');
  });
});
