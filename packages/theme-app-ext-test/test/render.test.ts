// What the embed's Liquid outputs for each configuration, rendered with the liquidjs
// stand-in for Shopify (src/render.ts).
import { describe, expect, it } from 'vitest';
import { defaultSettings, renderEmbed } from '../src/render.ts';

const onlyWhitespace = /^\s*$/u;

describe('the statement link', () => {
  it('renders nothing when no statement URL is known, so an enabled embed adds no markup', async () => {
    expect(await renderEmbed()).toMatch(onlyWhitespace);
  });

  it('links to the statement the app published (app-data metafield)', async () => {
    const html = await renderEmbed({ statementMetafield: '/pages/accessibility-statement' });
    expect(html).toContain(
      '<a class="rs-a11y__link" href="/pages/accessibility-statement">Accessibility</a>',
    );
    expect(html).toContain('aria-label="Accessibility information"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
  });

  it('prefers the merchant’s own URL setting over the metafield', async () => {
    const html = await renderEmbed({
      statementMetafield: '/pages/from-app',
      settings: { statement_url: 'https://example.com/a11y' },
    });
    expect(html).toContain('href="https://example.com/a11y"');
    expect(html).not.toContain('/pages/from-app');
  });

  it('hides the link when the merchant turns it off', async () => {
    const html = await renderEmbed({
      statementMetafield: '/pages/a',
      settings: { show_statement_link: false },
    });
    expect(html).toMatch(onlyWhitespace);
  });

  it('links only an https:// or same-site statement URL', async () => {
    for (const statementMetafield of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'http://example.com/a11y',
      '//evil.example/a11y',
      '/\\evil.example',
      'pages/a',
    ]) {
      expect(await renderEmbed({ statementMetafield }), statementMetafield).toMatch(onlyWhitespace);
    }
    expect(await renderEmbed({ statementMetafield: 'HTTPS://example.com/a' })).toContain(
      'href="HTTPS://example.com/a"',
    );
  });

  it('escapes the URL', async () => {
    const html = await renderEmbed({ statementMetafield: '/p?a=1&b="><script>x</script>' });
    expect(html).toContain('href="/p?a=1&amp;b=&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });
});

describe('the theme editor notice', () => {
  it('appears only in the theme editor, and only while the embed would show nothing', async () => {
    const notice = await renderEmbed({ designMode: true });
    expect(notice).toContain('rs-a11y__notice');
    expect(notice).toContain('The Accessibility link appears once');
    expect(await renderEmbed({ designMode: false })).toMatch(onlyWhitespace);
    const configured = await renderEmbed({ designMode: true, statementMetafield: '/pages/a' });
    expect(configured).not.toContain('rs-a11y__notice');
  });
});

describe('the barrier-report form', () => {
  it('is off by default', () => {
    expect(defaultSettings()).toEqual({
      show_statement_link: true,
      statement_url: null,
      show_report_form: false,
      color_scheme: 'theme',
    });
  });

  it('posts to the default app proxy path and loads one deferred script', async () => {
    const html = await renderEmbed({ settings: { show_report_form: true } });
    expect(html).toContain('action="/apps/rampsmith/barrier-report"');
    expect(html).toContain('method="post"');
    const scripts = html.match(/<script\b[^>]*>/gu) ?? [];
    expect(scripts).toEqual([
      '<script src="https://cdn.fixture.test/extensions/rampsmith/assets/rampsmith-barrier-report.js" defer>',
    ]);
  });

  it('follows a moved app proxy through the rampsmith.proxy_path metafield', async () => {
    const html = await renderEmbed({
      settings: { show_report_form: true },
      proxyPathMetafield: '/tools/a11y',
    });
    expect(html).toContain('action="/tools/a11y/barrier-report"');
  });

  it('ignores a proxy path that is not a plain same-site path', async () => {
    for (const proxyPathMetafield of [
      '//evil.example',
      'https://evil.example/x',
      'javascript:alert(1)//',
      'apps/rampsmith',
      '/apps/x?y=1',
      '/apps/../x',
      '/a\\b',
      `/apps/${'a'.repeat(40)}`,
    ]) {
      const html = await renderEmbed({ settings: { show_report_form: true }, proxyPathMetafield });
      expect(html, proxyPathMetafield).toContain('action="/apps/rampsmith/barrier-report"');
    }
  });

  it('sends the page path, page type and locale as hidden fields', async () => {
    const html = await renderEmbed({
      settings: { show_report_form: true },
      path: '/collections/shirts',
      pageType: 'collection',
      locale: 'fr',
    });
    expect(html).toContain('<input type="hidden" name="page" value="/collections/shirts">');
    expect(html).toContain('<input type="hidden" name="page_type" value="collection">');
    expect(html).toContain('<input type="hidden" name="locale" value="fr">');
  });

  it('sends no path from account, gift card or password pages, whose paths can carry secrets', async () => {
    for (const [pageType, path] of [
      ['customers/order', '/account/orders/1234567'],
      ['gift_card', '/gift_cards/56174706753/0011c591fc720d0a51b80cdb694f969e'],
      ['password', '/password'],
    ] as const) {
      const html = await renderEmbed({ settings: { show_report_form: true }, path, pageType });
      expect(html, pageType).toContain('name="page" value=""');
      expect(html, pageType).toContain(`name="page_type" value="${pageType}"`);
      expect(html, pageType).not.toContain(path);
    }
  });

  it('escapes the page path', async () => {
    const html = await renderEmbed({
      settings: { show_report_form: true },
      path: '/search"><img src=x onerror=alert(1)>',
    });
    expect(html).toContain('value="/search&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('links the store’s privacy policy when it has one', async () => {
    const withPolicy = await renderEmbed({ settings: { show_report_form: true } });
    expect(withPolicy).toContain('href="/policies/privacy-policy"');
    const without = await renderEmbed({
      settings: { show_report_form: true },
      privacyPolicyUrl: null,
    });
    expect(without).not.toContain('class="rs-a11y__inline-link"');
  });

  it('carries every status and error message for the script in data-msg-* attributes', async () => {
    const html = await renderEmbed({ settings: { show_report_form: true } });
    for (const name of [
      'sending',
      'sent',
      'failed',
      'rate-limited',
      'invalid',
      'error-prefix',
      'description-missing',
      'description-too-long',
      'email-invalid',
    ]) {
      expect(html).toMatch(new RegExp(`data-msg-${name}="[^"]+"`, 'u'));
    }
  });

  it('renders the form without the link when no statement is published', async () => {
    const html = await renderEmbed({ settings: { show_report_form: true } });
    expect(html).toContain('<form');
    expect(html).not.toContain('class="rs-a11y__link"');
  });
});

describe('colour schemes', () => {
  it('maps each option to its class and anything unexpected to the theme scheme', async () => {
    for (const [value, scheme] of [
      ['light', 'light'],
      ['dark', 'dark'],
      ['theme', 'theme'],
      ['"><x', 'theme'],
    ] as const) {
      const html = await renderEmbed({
        statementMetafield: '/p',
        settings: { color_scheme: value },
      });
      expect(html).toContain(`class="rs-a11y rs-a11y--${scheme}"`);
    }
  });
});
