// The static renderer's pure helpers and its Shopify behaviour on a small in-memory theme.
import { describe, expect, it } from 'vitest';
import {
  ThemeRenderer,
  escapeHtml,
  fnv1a,
  formatAmount,
  handleize,
  liquidString,
  parseWrapper,
} from '../src/render/renderer.ts';
import { loadStore, storeObjects } from '../src/render/store.ts';
import type { Theme } from '../src/render/theme.ts';

describe('helpers', () => {
  it('fnv1a is the 32-bit FNV-1a hash', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('escapes HTML text and attributes', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });

  it('formats cents with thousands separators', () => {
    expect(formatAmount(6800)).toBe('68.00');
    expect(formatAmount(123456789)).toBe('1,234,567.89');
    expect(formatAmount(5)).toBe('0.05');
  });

  it('handleizes like Shopify', () => {
    expect(handleize('Customers / Login')).toBe('customers-login');
    expect(handleize('  Summer Edit!  ')).toBe('summer-edit');
  });

  it('parses JSON template wrappers', () => {
    expect(parseWrapper('div#div_id.div_class[attribute-one=value]')).toEqual({
      open: '<div id="div_id" class="div_class" attribute-one="value">',
      close: '</div>',
    });
    expect(parseWrapper('main')).toEqual({ open: '<main>', close: '</main>' });
    expect(() => parseWrapper('span.x')).toThrow(/unsupported/);
  });

  it('turns Liquid values into text: nil is empty, objects are empty', () => {
    expect(liquidString(null)).toBe('');
    expect(liquidString(undefined)).toBe('');
    expect(liquidString(3)).toBe('3');
    expect(liquidString(false)).toBe('false');
    expect(liquidString({ a: 1 })).toBe('');
  });
});

function theme(files: Record<string, string>): Theme {
  const base: Record<string, string> = {
    'layout/theme.liquid':
      '<!doctype html><html lang="{{ request.locale.iso_code }}"><head><title>{{ page_title }}</title>{{ content_for_header }}</head><body>{% sections \'header-group\' %}<main>{{ content_for_layout }}</main></body></html>',
    'config/settings_schema.json':
      '[{"name":"theme_info"},{"name":"Colors","settings":[{"type":"color","id":"color_text","default":"#111111"},{"type":"image_picker","id":"logo"}]}]',
    'config/settings_data.json':
      '{"current":{"logo":"shopify://shop_images/logo-harbor-pine.png"}}',
    'locales/en.default.json':
      '{"general":{"hello":"Hello {{ name }} & co","items":{"one":"{{ count }} item","other":"{{ count }} items"},"raw_html":"<b>bold</b>"}}',
    'sections/header-group.json':
      '{"type":"header","name":"Header","sections":{"top":{"type":"bar","settings":{"text":"Hi"}}},"order":["top"]}',
    'sections/bar.liquid':
      '<p class="bar">{{ section.settings.text }}|{{ section.id }}|{{ settings.color_text }}</p>{% schema %}{"name":"Bar","tag":"header","class":"bar-section","settings":[{"type":"text","id":"text"}]}{% endschema %}',
    'templates/index.json':
      '{"sections":{"main":{"type":"main","settings":{},"blocks":{"b1":{"type":"note","settings":{"body":"First"}},"b2":{"type":"note","settings":{"body":"Second"}}},"block_order":["b2","b1"]}},"order":["main"],"wrapper":"div#Wrap"}',
    'sections/main.liquid':
      '<div class="main">{% content_for \'blocks\' %}{{ \'general.hello\' | t: name: shop.name }}|{{ \'general.items\' | t: count: 2 }}|{{ \'general.raw_html\' | t }}|{{ \'general.nope\' | t }}|{{ 6800 | money }}|{{ settings.logo | image_url: width: 100 | image_tag: class: "logo" }}|{{ \'now\' | date: \'%Y\' }}{% stylesheet %}.main{color:red}{% endstylesheet %}</div>{% schema %}{"name":"Main","blocks":[{"type":"@theme"}]}{% endschema %}',
    'blocks/note.liquid':
      '<span class="note">{{ block.settings.body }}</span>{% schema %}{"name":"Note","settings":[{"type":"text","id":"body"}]}{% endschema %}',
  };
  return { name: 'mini', files: new Map(Object.entries({ ...base, ...files })) };
}

describe('ThemeRenderer', () => {
  const store = storeObjects(loadStore('fixtures/store.json'));

  it('renders a JSON template inside the layout with Shopify section wrappers', () => {
    const html = new ThemeRenderer(theme({}), store).renderPage({
      id: 'index',
      template: 'index',
      path: '/',
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(
      /<header id="shopify-section-sections--\d+__top" class="shopify-section bar-section"><p class="bar">Hi\|sections--\d+__top\|#111111<\/p><\/header>/,
    );
    expect(html).toMatch(
      /<main><div id="Wrap"><div id="shopify-section-template--\d+__main" class="shopify-section">/,
    );
    expect(html).toContain('<span class="note">Second</span><span class="note">First</span>');
    expect(html).toContain(
      'Hello Harbor &amp; Pine &amp; co|2 items|<b>bold</b>|translation missing: en.general.nope',
    );
    expect(html).toContain('|$68.00|');
    expect(html).toContain(
      '<img src="/cdn/shop/files/logo-harbor-pine.png?v=1&amp;width=100" alt="Harbor &amp; Pine" width="100" height="30" class="logo">',
    );
    expect(html).toContain('|2026');
    expect(html).toContain('<style data-corpus="stylesheet-tags">\n.main{color:red}</style>');
    expect(html).not.toContain('{% schema');
  });

  it('refuses a section setting its schema does not define', () => {
    const bad = theme({
      'sections/header-group.json':
        '{"type":"header","name":"Header","sections":{"top":{"type":"bar","settings":{"nope":1}}},"order":["top"]}',
    });
    expect(() =>
      new ThemeRenderer(bad, store).renderPage({ id: 'i', template: 'index', path: '/' }),
    ).toThrow(/setting "nope" is not in the schema/);
  });

  it('fails on a filter Shopify has but the shim does not, rather than printing nothing', () => {
    const bad = theme({
      'sections/bar.liquid':
        '{{ "x" | color_modify: "alpha", 0.5 }}{% schema %}{"name":"Bar","settings":[{"type":"text","id":"text"}]}{% endschema %}',
    });
    expect(() =>
      new ThemeRenderer(bad, store).renderPage({ id: 'i', template: 'index', path: '/' }),
    ).toThrow(/color_modify/);
  });
});
