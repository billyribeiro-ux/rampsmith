// Reference implementation of Shopify's app proxy request signature (ADR-162). The api serves
// the app proxy and implements this in Rust; the browser tests' fake proxy uses this module,
// and both are held to Shopify's documented examples.
//
// Shopify (https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies,
// read 17 Oct 2026): the `signature` parameter is a hex HMAC-SHA256, keyed with the app's
// client secret, of the other query parameters, decoded, formatted as `key=value` with
// repeated values joined by commas, sorted, and concatenated with no separator. The request
// body is not signed.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Oldest accepted `timestamp`, in seconds before now. */
export const MAX_AGE_SECONDS = 300;
/** Newest accepted `timestamp`, in seconds after now (clock skew). */
export const MAX_SKEW_SECONDS = 30;

/** More parameters than this and the query is refused before any work is done. */
export const MAX_PARAMETERS = 64;

const SIGNATURE = /^[0-9a-f]{64}$/u;
const MYSHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u;
const SECONDS = /^[0-9]{1,12}$/u;
/** A proxy's storefront path: Shopify's four prefixes and a subpath of up to 30 characters. */
const PATH_PREFIX = /^\/(?:a|apps|community|tools)\/[A-Za-z0-9_-]{1,30}$/u;
const CUSTOMER_ID = /^[0-9]{0,20}$/u;

export type VerifyResult =
  | {
      readonly ok: true;
      readonly shop: string;
      readonly pathPrefix: string;
      readonly timestamp: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed-query'
        | 'missing-signature'
        | 'malformed-signature'
        | 'bad-signature'
        | 'bad-shop'
        | 'bad-timestamp'
        | 'stale'
        | 'bad-path-prefix'
        | 'bad-customer';
    };

function byUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The string Shopify signs: every parameter except `signature`. */
export function appProxyMessage(query: URLSearchParams): string {
  const values = new Map<string, string[]>();
  for (const [key, value] of query) {
    if (key === 'signature') continue;
    const list = values.get(key);
    if (list === undefined) values.set(key, [value]);
    else list.push(value);
  }
  return [...values]
    .map(([key, list]) => `${key}=${list.join(',')}`)
    .sort(byUtf8)
    .join('');
}

/** The hex HMAC-SHA256 signature of `query`, keyed with the app's client secret. */
export function appProxySignature(query: URLSearchParams, secret: string): string {
  return createHmac('sha256', secret).update(appProxyMessage(query), 'utf8').digest('hex');
}

/**
 * Verifies a proxied request's raw query string. The comparison is constant-time and runs
 * only on a well-formed signature, and a fresh timestamp bounds how long a request can be
 * replayed. Every parameter Shopify reserves must appear at most once (exactly once for
 * `shop`, `timestamp` and `path_prefix`), so a value a client put in the URL can never stand
 * beside or in front of Shopify's own. A valid signature proves the request came through
 * Shopify for `shop`; it says nothing about the shopper or the (unsigned) body.
 */
export function verifyAppProxyQuery(
  rawQuery: string,
  secret: string,
  nowSeconds: number,
): VerifyResult {
  if (secret === '') throw new Error('verifyAppProxyQuery: the client secret is empty');
  const query = new URLSearchParams(rawQuery);
  if ([...query.keys()].length > MAX_PARAMETERS) return { ok: false, reason: 'malformed-query' };
  const signatures = query.getAll('signature');
  if (signatures.length === 0) return { ok: false, reason: 'missing-signature' };
  const [given] = signatures;
  if (signatures.length !== 1 || given === undefined || !SIGNATURE.test(given)) {
    return { ok: false, reason: 'malformed-signature' };
  }
  const expected = Buffer.from(appProxySignature(query, secret), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(given, 'hex'))) {
    return { ok: false, reason: 'bad-signature' };
  }

  const shops = query.getAll('shop');
  const [shop] = shops;
  if (shops.length !== 1 || shop === undefined || !MYSHOPIFY.test(shop)) {
    return { ok: false, reason: 'bad-shop' };
  }
  const stamps = query.getAll('timestamp');
  const [stamp] = stamps;
  if (stamps.length !== 1 || stamp === undefined || !SECONDS.test(stamp)) {
    return { ok: false, reason: 'bad-timestamp' };
  }
  const timestamp = Number(stamp);
  if (timestamp < nowSeconds - MAX_AGE_SECONDS || timestamp > nowSeconds + MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const prefixes = query.getAll('path_prefix');
  const [pathPrefix] = prefixes;
  if (prefixes.length !== 1 || pathPrefix === undefined || !PATH_PREFIX.test(pathPrefix)) {
    return { ok: false, reason: 'bad-path-prefix' };
  }
  const customers = query.getAll('logged_in_customer_id');
  if (customers.length > 1 || customers.some((c) => !CUSTOMER_ID.test(c))) {
    return { ok: false, reason: 'bad-customer' };
  }
  return { ok: true, shop, pathPrefix, timestamp };
}
