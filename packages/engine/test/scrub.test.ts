import { describe, expect, it } from 'vitest';
import { scrubExcerpt, scrubSelector, scrubUrl } from '../src/scrub.ts';

describe('scrubSelector (audit L10, PLAN §19)', () => {
  it.each([
    // [hostile selector, scrubbed]
    ['input[value="shopper@example.com"]', 'input[value]'],
    ["a[href='/account/reset/4821/AbCdEf?token=eyJhbGciOi']", 'a[href]'],
    ['[data-customer=jane]', '[data-customer]'],
    ['[data-order = "1042" i]', '[data-order]'],
    ['img[src="https://cdn.shopify.com/s/files/jane-doe-passport.jpg"]', 'img[src]'],
    ['[aria-label="Jane Doe, 12 Elm Street"]', '[aria-label]'],
    ['[title="a] b@x.com"]', '[title]'],
    ['[title="say \\"hi\\" to jane@x.com"]', '[title]'],
    ['[placeholder="+1 (555) 010-9999"]', '[placeholder]'],
    ['[a="b"][c="d@e.com"][f]', '[a][c][f]'],
    ['form:not([action="/cart?key=secret"]) > button', 'form:not([action]) > button'],
    ['iframe[src="https://x.example/?id_token=abc"] >>> button.pay', 'iframe[src] >>> button.pay'],
  ])('drops the attribute values in %j', (hostile, scrubbed) => {
    expect(scrubSelector(hostile)).toBe(scrubbed);
  });

  it('keeps the values that only describe structure', () => {
    for (const selector of [
      'input[type="email"]',
      'a[role="button"][aria-hidden="true"]',
      'input[name="contact[email]"]',
      'a[target="_blank"][rel="noopener"]',
      '[tabindex="-1"]',
    ]) {
      expect(scrubSelector(selector)).toBe(selector);
    }
  });

  it('drops a structural attribute when its value looks like data', () => {
    expect(scrubSelector('input[name="jane@example.com"]')).toBe('input[name]');
    expect(scrubSelector(`input[name="${'x'.repeat(65)}"]`)).toBe('input[name]');
    expect(scrubSelector('input[type="a\\40 b"]')).toBe('input[type]');
  });

  it('removes email addresses from ids and classes, escaped or not', () => {
    expect(scrubSelector('#jane\\.doe\\@example\\.com > a')).toBe('#[email] > a');
    expect(scrubSelector('.user-jane@example.com')).toBe('.[email]');
    expect(scrubSelector('#plain\\@x\\.io, #a.b+c@d-e.org')).toBe('#[email], #[email]');
  });

  it('leaves ordinary structure alone, including long generated ids', () => {
    for (const selector of [
      '#shopify-section-template--15789012345678__main > .grid:nth-child(3) > img',
      '.product-card:nth-of-type(12) a',
      '#MainContent',
      'main > div:nth-child(2) > ul > li:nth-child(1) > a',
      'html',
    ]) {
      expect(scrubSelector(selector)).toBe(selector);
    }
  });

  it('cuts off an attribute selector that never closes, whatever it held', () => {
    expect(scrubSelector('a[href="jane@example.com')).toBe('a[]');
    expect(scrubSelector('a[href=')).toBe('a[]');
    expect(scrubSelector('a[href="x" junk]')).toBe('a[]');
    expect(scrubSelector('div > a[')).toBe('div > a[]');
  });

  it('removes control characters, which PostgreSQL text cannot hold', () => {
    expect(scrubSelector('a\u0000b\u0007[x="1\u0000"]\u009f')).toBe('ab[x]');
  });

  it('bounds its output and does not backtrack on hostile input', () => {
    const started = performance.now();
    scrubSelector('\\'.repeat(200_000));
    scrubSelector('[a="'.repeat(50_000));
    scrubSelector(`${'a'.repeat(100_000)}@`);
    scrubSelector('a\\@'.repeat(50_000));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(scrubSelector('a'.repeat(100_000)).length).toBeLessThanOrEqual(2048);
  });

  it('is idempotent', () => {
    for (const selector of [
      'input[value="shopper@example.com"]',
      '#jane\\.doe\\@example\\.com > a',
      'a[href="x',
      'input[type="email"] >>> [aria-label="x"]',
      '#shopify-section-template--1__main > img',
    ]) {
      const once = scrubSelector(selector);
      expect(scrubSelector(once)).toBe(once);
    }
  });

  it('never lets planted secrets through, whichever way they are wrapped', () => {
    const secrets = ['jane@example.com', 'eyJhbGciOiJIUzI1NiJ9', '4111111111111111', 'hunter2'];
    const wrappers = [
      (s: string) => `input[value="${s}"]`,
      (s: string) => `input[value='${s}']`,
      (s: string) => `input[value=${s.replaceAll('@', '\\@').replaceAll('.', '\\.')}]`,
      (s: string) => `a[href="/x?k=${s}#${s}"][title="${s}"]`,
      (s: string) => `div[data-${s.slice(0, 4)}="${s}"] >>> [alt="${s}"] i`,
      (s: string) => `:is(a[href="${s}"], b[x='${s}'])`,
    ];
    for (const secret of secrets) {
      for (const wrap of wrappers) {
        const scrubbed = scrubSelector(wrap(secret));
        expect(scrubbed, wrap(secret)).not.toContain(secret);
        expect(scrubbed, wrap(secret)).not.toContain('@');
      }
    }
  });
});

describe('scrubUrl (audit L10, PLAN §19)', () => {
  it.each([
    [
      'https://shop.example/products/scarf?variant=123&token=abc#reviews',
      'https://shop.example/products/scarf',
    ],
    [
      'https://shop.example/account/login?return_url=%2Fcart&email=jane%40example.com',
      'https://shop.example/account/login',
    ],
    ['https://shop.example/?', 'https://shop.example/'],
    ['https://shop.example#frag', 'https://shop.example/'],
    ['https://user:s3cret@shop.example:8443/a/b?x=1', 'https://shop.example:8443/a/b'],
    ['HTTP://Shop.Example:80/Path/../Other', 'http://shop.example/Other'],
    ['https://shop.example/a;jsessionid=ABC123/b', 'https://shop.example/a/b'],
    [
      'https://shop.example/pages/contact?id_token=eyJhbGciOiJIUzI1NiJ9.e30.sig&hmac=00ff',
      'https://shop.example/pages/contact',
    ],
  ])('keeps only origin and path of %j', (hostile, scrubbed) => {
    expect(scrubUrl(hostile)).toBe(scrubbed);
  });

  it('removes an email address or an opaque token from the path', () => {
    expect(scrubUrl('https://shop.example/account/jane.doe@example.com/orders')).toBe(
      'https://shop.example/account/[email]/orders',
    );
    expect(scrubUrl('https://shop.example/account/jane.doe%40example.com/orders')).toBe(
      'https://shop.example/account/[email]/orders',
    );
    expect(
      scrubUrl('https://shop.example/68094345273/orders/3f9a1c7e8b2d4f6a9c1e3b5d7f9a1c3e'),
    ).toBe('https://shop.example/68094345273/orders/[token]');
    expect(scrubUrl('https://shop.example/r/0b1f6c1e-8c0a-4f6e-9a55-3f1c2b7d9e10/x')).toBe(
      'https://shop.example/r/[token]/x',
    );
    expect(scrubUrl('https://shop.example/account/reset/4821/Ab3dEf9hIj2kLm5nOp8qRs1T')).toBe(
      'https://shop.example/account/reset/4821/[token]',
    );
  });

  it('keeps product and page handles, digits included', () => {
    for (const url of [
      'https://shop.example/products/classic-wool-scarf-in-heather-grey',
      'https://shop.example/products/sku-12345-large-red-sweater-xl-extra-long',
      'https://shop.example/collections/summer-2026/products/sandal',
      'https://shop.example/pages/accessibility-statement',
      'https://shop.example/',
    ]) {
      expect(scrubUrl(url)).toBe(url);
    }
  });

  it('reduces schemes that are not web pages to the scheme', () => {
    expect(scrubUrl('data:text/html,<p>jane@example.com</p>?x=1')).toBe('data:');
    expect(scrubUrl('javascript:alert(document.cookie)')).toBe('javascript:');
    expect(scrubUrl('blob:https://shop.example/0b1f6c1e-8c0a-4f6e-9a55-3f1c2b7d9e10')).toBe(
      'blob:',
    );
    expect(scrubUrl('chrome-error://chromewebdata/')).toBe('chrome-error:');
  });

  it('copes with text that is not a URL', () => {
    expect(scrubUrl('not a url?token=abc#frag')).toBe('not a url');
    expect(scrubUrl('')).toBe('');
    expect(scrubUrl('/relative/jane@example.com?x=1')).toBe('/relative/[email]');
    expect(scrubUrl(`https://shop.example/${'a/'.repeat(5000)}`).length).toBeLessThanOrEqual(2048);
  });

  it('removes control characters and is idempotent', () => {
    expect(scrubUrl('https://shop.example/a\u0000b')).not.toContain('\u0000');
    for (const url of [
      'https://shop.example/products/scarf?variant=123#x',
      'https://shop.example/account/jane.doe@example.com/orders',
      'https://shop.example/68094345273/orders/3f9a1c7e8b2d4f6a9c1e3b5d7f9a1c3e',
      'data:text/html,hello',
      'not a url?token=abc',
    ]) {
      const once = scrubUrl(url);
      expect(scrubUrl(once)).toBe(once);
    }
  });
});

describe('scrubExcerpt (unchanged)', () => {
  it('still removes values, email addresses and phone numbers', () => {
    const html = scrubExcerpt('<input value="x" data-e="a@b.co"> call +1 (555) 010-9999');
    expect(html).toBe('<input value="" data-e="[email]"> call [phone]');
  });
});
