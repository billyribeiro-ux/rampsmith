import { describe, expect, it } from 'vitest';
import { frameAncestors, shopFromQuery } from './frame.ts';

const at = (query: string) => new URL(`https://web.example/app${query}`);

describe('shopFromQuery', () => {
  it('accepts a lowercase myshopify host', () => {
    expect(shopFromQuery(at('?shop=demo-store.myshopify.com&host=abc'))).toBe(
      'demo-store.myshopify.com',
    );
  });

  it('rejects anything else', () => {
    for (const shop of [
      '',
      'evil.com',
      'demo.myshopify.com.evil.com',
      'https://demo.myshopify.com',
      'Demo.myshopify.com',
      '-demo.myshopify.com',
      'demo store.myshopify.com',
      'demo.myshopify.com;frame-ancestors *',
    ]) {
      expect(shopFromQuery(at(`?shop=${encodeURIComponent(shop)}`)), shop).toBeUndefined();
    }
    expect(shopFromQuery(at(''))).toBeUndefined();
  });
});

describe('frameAncestors', () => {
  it('allows only Shopify admin and the shop for embedded launches', () => {
    expect(frameAncestors(at('?shop=demo.myshopify.com'))).toBe(
      'frame-ancestors https://admin.shopify.com https://demo.myshopify.com',
    );
  });

  it('forbids framing without a valid shop', () => {
    expect(frameAncestors(at(''))).toBe("frame-ancestors 'none'");
    expect(frameAncestors(at('?shop=*.myshopify.com'))).toBe("frame-ancestors 'none'");
  });
});
