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

/**
 * The theme editor with Rampsmith's app embed switched on, the deep link Shopify documents for
 * setup instructions (App Store requirement 5.1.3). `apiKey` is the app's client id and
 * `handle` is the file name of the embed block in `extensions/theme-app-ext/blocks/`.
 */
export function embedActivationUrl(
  shop: string,
  apiKey: string,
  handle = 'accessibility',
): string | undefined {
  const match = /^([a-z0-9][a-z0-9-]*\.myshopify\.com)$/u.exec(shop);
  if (match === null || apiKey === '') return undefined;
  const query = new URLSearchParams({
    context: 'apps',
    activateAppId: `${apiKey}/${handle}`,
  });
  return `https://${match[1] ?? ''}/admin/themes/current/editor?${query.toString()}`;
}
