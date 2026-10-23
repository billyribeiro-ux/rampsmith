import { describe, expect, it } from 'vitest';
import { isEmailAddress, mailtoLink, parseLink, parseOrigin, type Origins } from '../src/links.ts';

const origins: Origins = {
  app: 'https://app.rampsmith.example',
  site: 'https://rampsmith.example',
  shopifyAdmin: 'https://admin.shopify.com',
  oneClick: 'https://hooks.rampsmith.example',
};

describe('parseOrigin', () => {
  it('accepts HTTPS origins and loopback HTTP for development', () => {
    expect(parseOrigin('https://app.rampsmith.example')).toBe('https://app.rampsmith.example');
    expect(parseOrigin('https://app.rampsmith.example/')).toBe('https://app.rampsmith.example');
    expect(parseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(parseOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it.each([
    'http://app.rampsmith.example',
    'https://app.rampsmith.example/path',
    'https://app.rampsmith.example?q=1',
    'https://user@app.rampsmith.example',
    'https://app.rampsmith.example:443',
    'ftp://app.rampsmith.example',
    'app.rampsmith.example',
    'https://app.rampsmith.example\\',
    ' https://app.rampsmith.example',
  ])('rejects %j', (origin) => {
    expect(parseOrigin(origin)).toBeNull();
  });
});

describe('parseLink', () => {
  it('accepts links on an allowed origin and normalises them', () => {
    expect(parseLink('https://app.rampsmith.example/a?b=c#d', ['app'], origins)).toBe(
      'https://app.rampsmith.example/a?b=c#d',
    );
    expect(parseLink('HTTPS://APP.RAMPSMITH.EXAMPLE/x', ['app'], origins)).toBe(
      'https://app.rampsmith.example/x',
    );
    expect(
      parseLink('https://admin.shopify.com/store/s/apps/rampsmith', ['shopifyAdmin'], origins),
    ).toBe('https://admin.shopify.com/store/s/apps/rampsmith');
  });

  it('keeps the query exactly: no tracking parameters are added', () => {
    const link = 'https://app.rampsmith.example/sign-in/link?token=abc';
    expect(parseLink(link, ['app'], origins)).toBe(link);
  });

  it.each([
    ['another site', 'https://evil.example/'],
    ['a look-alike host', 'https://app.rampsmith.example.evil.example/'],
    ['credentials before the host', 'https://app.rampsmith.example@evil.example/'],
    ['credentials on the right host', 'https://user:pass@app.rampsmith.example/'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', '/sign-in'],
    ['a protocol-relative link', '//evil.example/'],
    ['a backslash trick', 'https://app.rampsmith.example\\@evil.example/'],
    ['whitespace', 'https://app.rampsmith.example/ a'],
    ['a line break', 'https://app.rampsmith.example/\nSet-Cookie: x'],
    ['a NUL', 'https://app.rampsmith.example/\u0000'],
    ['plain HTTP', 'http://app.rampsmith.example/'],
    ['another port', 'https://app.rampsmith.example:8443/'],
    ['the site origin where only the app is allowed', 'https://rampsmith.example/'],
    ['a link longer than 2048 characters', `https://app.rampsmith.example/${'a'.repeat(2048)}`],
  ])('rejects %s', (_name, value) => {
    expect(parseLink(value, ['app'], origins)).toBeNull();
  });
});

describe('isEmailAddress', () => {
  it.each(['support@rampsmith.example', 'a.b+c@sub.example.org', "o'neil@example.com"])(
    'accepts %j',
    (value) => {
      expect(isEmailAddress(value)).toBe(true);
    },
  );

  it.each([
    'Support <support@rampsmith.example>',
    'a@b@example.com',
    'a,b@example.com',
    'a@example.com, b@example.com',
    'a@example.com\nBcc: b@example.com',
    'a b@example.com',
    '"a"@example.com',
    'a@localhost',
    '@example.com',
    'a..b@example.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(250)}.com`,
  ])('rejects %j', (value) => {
    expect(isEmailAddress(value)).toBe(false);
  });
});

describe('mailtoLink', () => {
  it('builds a mailto link for a plain address only', () => {
    expect(mailtoLink('support@rampsmith.example')).toBe('mailto:support@rampsmith.example');
    expect(() => mailtoLink('a@example.com?cc=b@example.com')).toThrow(TypeError);
  });
});
