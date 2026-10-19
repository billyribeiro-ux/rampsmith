/**
 * Clickjacking protection for the embedded app (shopify.dev, "Set up iframe protection"):
 * `frame-ancestors` names Shopify admin and the one shop, never a wildcard. The shop comes
 * from the launch URL's `shop` parameter; it only widens framing to that shop, and the page
 * holds no data until a verified session token arrives (ADR-022).
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The launch URL's `shop` parameter when it is a valid `*.myshopify.com` host. */
export function shopFromQuery(url: URL): string | undefined {
  const shop = url.searchParams.get('shop');
  return shop !== null && shop.length <= 255 && SHOP_DOMAIN.test(shop) ? shop : undefined;
}

/** The `frame-ancestors` directive for a request to `url`. */
export function frameAncestors(url: URL): string {
  const shop = shopFromQuery(url);
  return shop === undefined
    ? "frame-ancestors 'none'"
    : `frame-ancestors https://admin.shopify.com https://${shop}`;
}
