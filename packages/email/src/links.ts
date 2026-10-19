/**
 * Links in emails (ADR-193). Every link points at an origin Rampsmith controls or at the
 * merchant's own Shopify admin, never anywhere an input could choose, and is written exactly as
 * given: no tracking parameters, no redirect service.
 */

import { isControlCharacter } from './sanitize.ts';

declare const safeUrlBrand: unique symbol;

/** An absolute URL that passed {@link parseLink}, normalised by the WHATWG URL parser. */
export type SafeUrl = string & { readonly [safeUrlBrand]: true };

/** The merchant's Shopify admin, where the embedded app's deep links live. */
export const SHOPIFY_ADMIN_ORIGIN = 'https://admin.shopify.com';

/** The places a link may point to. */
export type OriginName = 'app' | 'site' | 'shopifyAdmin';

export type Origins = Readonly<Record<OriginName, string>>;

/** Longest link accepted; the sign-in and unsubscribe links are far shorter. */
const MAX_LINK_LENGTH = 2048;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whitespace, control characters and backslashes never belong in a link we send. */
function hasUnsafeLinkCharacter(value: string): boolean {
  return /[\s\\]/u.test(value) || value.split('').some(isControlCharacter);
}

/**
 * Checks that `origin` is exactly an origin (scheme, host, optional port; no path) using HTTPS,
 * or HTTP on a loopback host for local development. Returns the canonical form.
 */
export function parseOrigin(origin: string): string | null {
  if (!URL.canParse(origin) || hasUnsafeLinkCharacter(origin)) {
    return null;
  }
  const url = new URL(origin);
  const canonical = url.origin;
  if (canonical !== origin.replace(/\/$/u, '').toLowerCase()) {
    return null;
  }
  if (url.protocol === 'https:') {
    return canonical;
  }
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) ? canonical : null;
}

/**
 * Validates `value` as a link to one of `allowed` origins. Returns the normalised URL, or null
 * when the value is not an absolute HTTP(S) URL on an allowed origin, carries credentials, or
 * holds characters that mail clients and URL parsers disagree about.
 */
export function parseLink(
  value: string,
  allowed: readonly OriginName[],
  origins: Origins,
): SafeUrl | null {
  if (value.length > MAX_LINK_LENGTH || hasUnsafeLinkCharacter(value)) {
    return null;
  }
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  if (!allowed.some((name) => origins[name] === url.origin)) {
    return null;
  }
  return url.href as SafeUrl;
}

/**
 * A support-style address, such as `support@rampsmith.com`: letters, digits, dots, hyphens,
 * underscores and plus signs only, so it can never carry `mailto:` header fields (`?cc=`).
 */
export function isSimpleAddress(value: string): boolean {
  return isEmailAddress(value) && /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/u.test(value);
}

/** A `mailto:` link for an address that passed {@link isSimpleAddress}. */
export function mailtoLink(address: string): SafeUrl {
  if (!isSimpleAddress(address)) {
    throw new TypeError('mailtoLink needs a simple email address');
  }
  return `mailto:${address}` as SafeUrl;
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;

/**
 * A single plain address (`local@domain`): ASCII, no display name, no comments, no quoting, at
 * most 254 characters. Anything else could smuggle extra recipients or headers.
 */
export function isEmailAddress(value: string): boolean {
  if (value.length > 254) {
    return false;
  }
  const at = value.lastIndexOf('@');
  if (at < 1) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && LOCAL_PART.test(local) && DOMAIN.test(domain);
}
