import { describe, expect, it } from 'vitest';
import { securityHeaders } from './headers.ts';

function apply(href: string, csp?: string): Headers {
  const headers = new Headers(csp === undefined ? {} : { 'content-security-policy': csp });
  securityHeaders(new URL(href), headers);
  return headers;
}

describe('securityHeaders', () => {
  it('lets Shopify admin and the launching shop frame embedded routes', () => {
    const csp = apply(
      'https://web.example/app?shop=demo.myshopify.com',
      "script-src 'self' 'nonce-x'",
    ).get('content-security-policy');
    expect(csp).toBe(
      "script-src 'self' 'nonce-x'; frame-ancestors https://admin.shopify.com https://demo.myshopify.com",
    );
  });

  it('forbids framing of every other route and of embedded routes without a shop', () => {
    for (const href of [
      'https://web.example/',
      'https://web.example/dashboard?shop=demo.myshopify.com',
      'https://web.example/application?shop=demo.myshopify.com',
      'https://web.example/app',
    ]) {
      expect(apply(href).get('content-security-policy'), href).toBe("frame-ancestors 'none'");
    }
  });

  it('sets the baseline headers, and HSTS only over HTTPS', () => {
    const secure = apply('https://web.example/');
    expect(secure.get('x-content-type-options')).toBe('nosniff');
    expect(secure.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(secure.get('strict-transport-security')).toContain('max-age=31536000');
    expect(apply('http://127.0.0.1:3000/').get('strict-transport-security')).toBeNull();
  });
});
