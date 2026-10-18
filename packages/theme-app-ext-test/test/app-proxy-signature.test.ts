// Reference implementation of Shopify's app proxy signature (ADR-162), checked against the
// two worked examples on shopify.dev (Authenticate app proxies, read 17 Oct 2026): shared
// secret "hush", timestamp 1317327555, shop "shop-name.myshopify.com".
import { describe, expect, it } from 'vitest';
import {
  MAX_AGE_SECONDS,
  MAX_SKEW_SECONDS,
  appProxyMessage,
  appProxySignature,
  verifyAppProxyQuery,
} from '../src/app-proxy-signature.ts';

const SECRET = 'hush';
const LOGGED_IN =
  'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb';
const ANONYMOUS =
  'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb';
const NOW = 1317327555;

describe('appProxyMessage', () => {
  it('builds the documented string: decoded, repeated values joined by commas, sorted, no separator', () => {
    expect(appProxyMessage(new URLSearchParams(LOGGED_IN))).toBe(
      'extra=1,2logged_in_customer_id=1path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555',
    );
  });

  it('keeps a key whose value is empty', () => {
    expect(appProxyMessage(new URLSearchParams(ANONYMOUS))).toContain('logged_in_customer_id=path');
  });

  it('sorts by UTF-8 bytes, as the documented Ruby example does', () => {
    // "Z" (0x5a) sorts before "a" (0x61), and "é" (0xc3 0xa9) after both.
    expect(appProxyMessage(new URLSearchParams('é=3&a=2&Z=1'))).toBe('Z=1a=2é=3');
  });
});

describe('appProxySignature', () => {
  it('reproduces both documented signatures', () => {
    expect(appProxySignature(new URLSearchParams(LOGGED_IN), SECRET)).toBe(
      '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb',
    );
    expect(appProxySignature(new URLSearchParams(ANONYMOUS), SECRET)).toBe(
      'e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb',
    );
  });
});

describe('verifyAppProxyQuery', () => {
  it('accepts both documented requests at their own timestamp', () => {
    for (const query of [LOGGED_IN, ANONYMOUS]) {
      expect(verifyAppProxyQuery(query, SECRET, NOW)).toEqual({
        ok: true,
        shop: 'shop-name.myshopify.com',
        pathPrefix: '/apps/awesome_reviews',
        timestamp: NOW,
      });
    }
  });

  it('rejects a changed parameter, a wrong secret and a missing signature', () => {
    expect(verifyAppProxyQuery(LOGGED_IN.replace('extra=2', 'extra=3'), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(verifyAppProxyQuery(LOGGED_IN, 'not-hush', NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(verifyAppProxyQuery(LOGGED_IN.replace(/&signature=.*$/u, ''), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'missing-signature',
    });
  });

  it('rejects a parameter added after signing', () => {
    expect(verifyAppProxyQuery(`${LOGGED_IN}&shop=other.myshopify.com`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a repeated, short, long or non-hex signature without comparing it', () => {
    const sig = '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb';
    for (const bad of [`${sig}&signature=${sig}`, sig.slice(0, 63), `${sig}0`, sig.toUpperCase()]) {
      const query = LOGGED_IN.replace(sig, bad);
      expect(verifyAppProxyQuery(query, SECRET, NOW)).toEqual({
        ok: false,
        reason: 'malformed-signature',
      });
    }
  });

  it('rejects a timestamp older than five minutes or more than 30 seconds ahead', () => {
    expect([MAX_AGE_SECONDS, MAX_SKEW_SECONDS]).toEqual([300, 30]);
    expect(verifyAppProxyQuery(LOGGED_IN, SECRET, NOW + MAX_AGE_SECONDS).ok).toBe(true);
    expect(verifyAppProxyQuery(LOGGED_IN, SECRET, NOW + MAX_AGE_SECONDS + 1)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyAppProxyQuery(LOGGED_IN, SECRET, NOW - MAX_SKEW_SECONDS).ok).toBe(true);
    expect(verifyAppProxyQuery(LOGGED_IN, SECRET, NOW - MAX_SKEW_SECONDS - 1)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('rejects a signed request whose shop is not a myshopify.com domain', () => {
    const query = new URLSearchParams(
      'shop=evil.example.com&timestamp=1317327555&path_prefix=/apps/x',
    );
    query.set('signature', appProxySignature(query, SECRET));
    expect(verifyAppProxyQuery(query.toString(), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad-shop',
    });
  });

  it('rejects a signed request with a missing or non-numeric timestamp', () => {
    for (const timestamp of ['', 'soon', '1e9', '-5']) {
      const query = new URLSearchParams(`shop=a.myshopify.com&timestamp=${timestamp}`);
      query.set('signature', appProxySignature(query, SECRET));
      expect(verifyAppProxyQuery(query.toString(), SECRET, NOW)).toEqual({
        ok: false,
        reason: 'bad-timestamp',
      });
    }
  });

  it('refuses an empty secret', () => {
    expect(() => verifyAppProxyQuery(LOGGED_IN, '', NOW)).toThrow(/secret/u);
  });
});
