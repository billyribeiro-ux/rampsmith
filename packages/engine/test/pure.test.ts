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
  const page = (over: Partial<Parameters<typeof detectChallenge>[0]>) => ({
    status: 200,
    title: 'Shop',
    html: '',
    url: 'https://shop.example/',
    headers: {},
    ...over,
  });
  // A storefront home page as S-2 saw it: dozens of links, Shopify sections, and the hCaptcha
  // script Shopify loads for its newsletter and contact forms (docs/spikes/S-2).
  const storefront = [
    '<script src="https://js.hcaptcha.com/1/api.js"></script>',
    '<div id="shopify-section-template--1__main">',
    ...Array.from({ length: 40 }, (_, i) => `<a href="/products/p${i.toString()}">P</a>`),
    '<form><div class="h-captcha" data-sitekey="1"></div></form></div>',
  ].join('');

  it('recognises Cloudflare challenges from the header, the title or the challenge markup', () => {
    expect(detectChallenge(page({ status: 403, headers: { 'cf-mitigated': 'challenge' } }))).toBe(
      'cloudflare',
    );
    expect(detectChallenge(page({ status: 403, title: 'Just a moment...' }))).toBe('cloudflare');
    expect(detectChallenge(page({ html: '<script>window._cf_chl_opt={}</script>' }))).toBe(
      'cloudflare',
    );
    expect(detectChallenge(page({ html: '<div id="cf-chl-widget">' }))).toBe('cloudflare');
  });

  it("recognises Shopify's own challenge page and a page that is only a CAPTCHA", () => {
    expect(detectChallenge(page({ url: 'https://shop.example/challenge' }))).toBe('captcha');
    expect(
      detectChallenge(
        page({ html: '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>' }),
      ),
    ).toBe('captcha');
    expect(detectChallenge(page({ html: '<div class="h-captcha" data-sitekey="1"></div>' }))).toBe(
      'captcha',
    );
    expect(
      detectChallenge(
        page({ html: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">' }),
      ),
    ).toBe('captcha');
  });

  it('does not mistake a storefront that loads a CAPTCHA for its forms for a challenge', () => {
    expect(detectChallenge(page({ html: storefront }))).toBeUndefined();
    expect(
      detectChallenge(page({ html: storefront.replace('shopify-section', 'site-section') })),
    ).toBeUndefined();
  });

  it('reports rate limiting and leaves ordinary pages alone', () => {
    expect(detectChallenge(page({ status: 429, title: 'Too many' }))).toBe('rate_limited');
    expect(
      detectChallenge(page({ title: 'Allbirds', html: '<main>shoes</main>' })),
    ).toBeUndefined();
    expect(
      detectChallenge(page({ url: 'https://shop.example/collections/challenge-kits' })),
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
