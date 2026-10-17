import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectChallenge } from '../src/challenge.ts';
import { signScanToken } from '../src/egress-token.ts';
import { fingerprint, normalizeSelector, templateOrigin } from '../src/fingerprint.ts';
import { parseRobots } from '../src/robots.ts';
import { BOT_TOKEN, userAgent } from '../src/user-agent.ts';
import { criteriaFromTags } from '../src/wcag.ts';

describe('criteriaFromTags', () => {
  it('reads success criteria from axe tags and ignores level and other tags', () => {
    expect(
      criteriaFromTags(['cat.text-alternatives', 'wcag2a', 'wcag111', 'section508', 'TTv5']),
    ).toEqual(['1.1.1']);
    expect(criteriaFromTags(['wcag2aa', 'wcag1410', 'wcag2411', 'wcag258', 'wcag143'])).toEqual([
      '1.4.3',
      '1.4.10',
      '2.4.11',
      '2.5.8',
    ]);
    expect(criteriaFromTags(['best-practice'])).toEqual([]);
  });
});

describe('fingerprints', () => {
  it('strip positional indexes and generated ids from selectors', () => {
    expect(
      normalizeSelector('#shopify-section-template--1234__main > div:nth-child(3) > img'),
    ).toBe('#* > div > img');
    expect(normalizeSelector('.product-card:nth-of-type(12) a[href="/products/x"]')).toBe(
      '.product-card a[href="/products/x"]',
    );
    expect(normalizeSelector('#MainContent > .grid')).toBe('#MainContent > .grid');
  });

  it('name the template section without its instance number', () => {
    expect(templateOrigin('shopify-section-template--16053935014049__main')).toBe(
      'template--*__main',
    );
    expect(templateOrigin('shopify-section-sections--16053934__header')).toBe(
      'sections--*__header',
    );
    expect(templateOrigin(undefined)).toBe('');
  });

  it('are stable, 32 bytes, and differ by rule, selector and origin', () => {
    const a = fingerprint('image-alt', 'div:nth-child(2) > img', 'template--1__main');
    const b = fingerprint('image-alt', 'div:nth-child(9) > img', 'template--7__main');
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    for (const other of [
      fingerprint('color-contrast', 'div > img', 'template--*__main'),
      fingerprint('image-alt', 'span > img', 'template--*__main'),
      fingerprint('image-alt', 'div > img', 'sections--*__footer'),
    ]) {
      expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
    }
  });
});

describe('detectChallenge', () => {
  it('recognises bot challenges without trying to pass them', () => {
    expect(detectChallenge({ status: 403, title: 'Just a moment...', html: '' })).toBe(
      'cloudflare',
    );
    expect(detectChallenge({ status: 200, title: 'Shop', html: '<div id="cf-chl-widget">' })).toBe(
      'cloudflare',
    );
    expect(
      detectChallenge({
        status: 200,
        title: 'x',
        html: '<iframe src="https://www.google.com/recaptcha/api2/anchor">',
      }),
    ).toBe('captcha');
    expect(
      detectChallenge({
        status: 200,
        title: 'x',
        html: '<div class="h-captcha" data-sitekey="1">',
      }),
    ).toBe('captcha');
    expect(detectChallenge({ status: 429, title: 'Too many', html: '' })).toBe('rate_limited');
    expect(
      detectChallenge({ status: 200, title: 'Allbirds', html: '<main>shoes</main>' }),
    ).toBeUndefined();
  });
});

describe('signScanToken', () => {
  const vectors = JSON.parse(
    readFileSync(new URL('../../../crates/egress/testdata/tokens.json', import.meta.url), 'utf8'),
  ) as { secret: string; valid: { token: string; payload: Parameters<typeof signScanToken>[1] }[] };

  it('produces exactly the tokens egress verifies', () => {
    for (const { token, payload } of vectors.valid) {
      expect(signScanToken(vectors.secret, payload)).toBe(token);
    }
  });

  it('refuses short secrets', () => {
    const [first] = vectors.valid;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(() => signScanToken('short', first.payload)).toThrow();
  });
});

describe('userAgent', () => {
  it('names Rampsmith with a product token robots.txt can match, and links to the bot page', () => {
    const ua = userAgent('1.2.3', 'https://example.com/bot');
    expect(ua).toBe('RampsmithBot/1.2.3 (+https://example.com/bot; accessibility scanner)');
    expect(ua.startsWith(`${BOT_TOKEN}/`)).toBe(true);
    expect(userAgent('1.2.3')).toContain('docs/bot.md');
    expect(parseRobots(`User-agent: ${BOT_TOKEN}\nDisallow: /`).allows(BOT_TOKEN, '/')).toBe(false);
  });
});
