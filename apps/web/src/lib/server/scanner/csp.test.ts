import { describe, expect, it } from 'vitest';
import { allowTurnstile, isScannerPath } from './csp.ts';

const BASE =
  "default-src 'self'; script-src 'self' https://cdn.shopify.com/shopifycloud/ 'nonce-abc'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'";
const ORIGIN = 'https://challenges.cloudflare.com';

describe('isScannerPath', () => {
  it('matches the scanner page and nothing that merely starts with its name', () => {
    expect(isScannerPath('/scan')).toBe(true);
    expect(isScannerPath('/scan/')).toBe(true);
    expect(isScannerPath('/scanner')).toBe(false);
    expect(isScannerPath('/dashboard/scan')).toBe(false);
  });
});

describe('allowTurnstile', () => {
  it('adds the widget origin to script-src and adds frame-src, and changes nothing else', () => {
    const policy = new Map(
      allowTurnstile(BASE, ORIGIN)
        .split(';')
        .map((part) => {
          const [name = '', ...sources] = part.trim().split(/\s+/u);
          return [name, sources] as const;
        }),
    );
    expect(policy.get('script-src')).toEqual([
      "'self'",
      'https://cdn.shopify.com/shopifycloud/',
      "'nonce-abc'",
      ORIGIN,
    ]);
    expect(policy.get('frame-src')).toEqual([ORIGIN]);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
  });

  it('extends an existing frame-src instead of repeating the directive', () => {
    const out = allowTurnstile(`${BASE}; frame-src 'self'`, ORIGIN);
    expect(out.match(/frame-src/gu)).toHaveLength(1);
    expect(out).toContain(`frame-src 'self' ${ORIGIN}`);
  });

  it('does not add the origin twice', () => {
    const once = allowTurnstile(BASE, ORIGIN);
    expect(allowTurnstile(once, ORIGIN)).toBe(once);
  });

  it('leaves an empty policy empty', () => {
    expect(allowTurnstile('', ORIGIN)).toBe('');
  });
});
