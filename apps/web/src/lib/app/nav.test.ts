import { describe, expect, it } from 'vitest';
import { appHref, carriedQuery, embedActivationUrl, planPageUrl } from './nav.ts';

describe('embedActivationUrl', () => {
  it('opens the theme editor with the app embed switched on, as Shopify documents it', () => {
    const url = embedActivationUrl('demo-store.myshopify.com', 'client-id-1');
    expect(url).toBe(
      'https://demo-store.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=client-id-1%2Faccessibility',
    );
    const parsed = new URL(url ?? '');
    expect(parsed.searchParams.get('activateAppId')).toBe('client-id-1/accessibility');
  });

  it('gives nothing for a shop that is not a myshopify.com domain or a missing client id', () => {
    expect(embedActivationUrl('evil.example.com', 'client-id-1')).toBeUndefined();
    expect(embedActivationUrl('demo-store.myshopify.com.evil.example', 'k')).toBeUndefined();
    expect(embedActivationUrl('', 'k')).toBeUndefined();
    expect(embedActivationUrl('demo-store.myshopify.com', '')).toBeUndefined();
  });
});

describe('the other links', () => {
  it('carries only shop, host and embedded', () => {
    const search = new URLSearchParams('shop=a.myshopify.com&host=h&embedded=1&x=2');
    expect(carriedQuery(search)).toBe('shop=a.myshopify.com&host=h&embedded=1');
    expect(appHref('/app/log', 'shop=a')).toBe('/app/log?shop=a');
  });

  it('links to the hosted plan page of the shop only', () => {
    expect(planPageUrl('cool-shop.myshopify.com')).toBe(
      'https://admin.shopify.com/store/cool-shop/charges/rampsmith/pricing_plans',
    );
    expect(planPageUrl('cool-shop.example.com')).toBeUndefined();
  });
});
