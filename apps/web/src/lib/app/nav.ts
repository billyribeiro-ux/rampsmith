/**
 * In-app links keep `shop`, `host` and `embedded` from the URL Shopify opened the app with, so
 * App Bridge still finds its host after a client-side navigation.
 */
const CARRIED = ['shop', 'host', 'embedded'] as const;

/** The query string to carry, from the current URL's search parameters. */
export function carriedQuery(search: { get(name: string): string | null }): string {
  const out = new URLSearchParams();
  for (const key of CARRIED) {
    const value = search.get(key);
    if (value !== null) out.set(key, value);
  }
  return out.toString();
}

/** `/app/findings` plus the carried query. */
export function appHref(path: string, carry: string): string {
  return carry === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${carry}`;
}

/** Shopify's hosted plan page for the shop (PLAN §20, ADR-131). */
export function planPageUrl(shop: string, appHandle = 'rampsmith'): string | undefined {
  const match = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/u.exec(shop);
  return match === null
    ? undefined
    : `https://admin.shopify.com/store/${match[1] ?? ''}/charges/${appHandle}/pricing_plans`;
}
