/**
 * Links into the embedded app, for the emails that point at it (ADR-279). The merchant opens the
 * app inside their Shopify admin, at `https://admin.shopify.com/store/<store>/apps/<app handle>`;
 * the app's own origin cannot be opened on its own because its pages need the admin's session.
 *
 * The mailer builds these when it sends, from the store's permanent domain and the app's handle,
 * so the jobs that queue the emails need to know neither. The handle is the `handle` of
 * `shopify.app.toml`; another Shopify app (a staging app) has another, set in `SHOPIFY_APP_HANDLE`.
 */
import type { EmailKind } from '@rampsmith/email';

/** The handle of `shopify.app.toml`. */
export const DEFAULT_APP_HANDLE = 'rampsmith';

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SHOP_DOMAIN = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/u;

/** The template member that holds the link, and the app page it opens. */
const LINKS: Readonly<
  Partial<Record<EmailKind, { readonly member: string; readonly path: string }>>
> = {
  welcome: { member: 'appUrl', path: '' },
  first_scan_complete: { member: 'findingsUrl', path: '/findings' },
  weekly_summary: { member: 'dashboardUrl', path: '' },
  fix_verified: { member: 'logUrl', path: '/log' },
  regression_alert: { member: 'findingsUrl', path: '/regressions' },
};

/** Whether `handle` can be put in a link. */
export function isAppHandle(handle: string): boolean {
  return HANDLE.test(handle);
}

/**
 * The link member for `kind`, or an empty object when the template carries none or the store's
 * domain is not a `*.myshopify.com` host (the template then reports the missing link itself).
 */
export function appLinkFor(
  kind: EmailKind,
  shopDomain: string,
  appHandle: string,
): Record<string, string> {
  const entry = LINKS[kind];
  const store = SHOP_DOMAIN.exec(shopDomain)?.[1];
  if (entry === undefined || store === undefined || !isAppHandle(appHandle)) return {};
  return {
    [entry.member]: `https://admin.shopify.com/store/${store}/apps/${appHandle}${entry.path}`,
  };
}
