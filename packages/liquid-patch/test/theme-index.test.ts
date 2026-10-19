/**
 * What the mapper reads from a theme before it looks at any element (ADR-244): the section
 * instance a wrapper id names, the files an instance renders, the values of plain settings
 * lookups, and the element search's tolerance for Liquid.
 */
import { describe, expect, it } from 'vitest';
import { searchElements } from '../src/map/elements.ts';
import {
  ThemeIndex,
  layoutFor,
  renderClosure,
  sectionInstances,
  settingText,
} from '../src/map/theme.ts';
import { node, rendered, tarnIndex } from './tarn.ts';

function theme(files: Record<string, string>): ThemeIndex {
  return new ThemeIndex(new Map(Object.entries(files)));
}

describe('ThemeIndex', () => {
  it('lists paths by directory and extension, sorted', () => {
    const index = tarnIndex();
    expect(index.paths('sections', '.json')).toEqual(['sections/header-group.json']);
    expect(index.paths('snippets', '.liquid')).toEqual(['snippets/search-form.liquid']);
  });

  it('parses Liquid and JSON once, and says null/undefined for bad or missing files', () => {
    const index = theme({
      'sections/a.liquid': '<div>{% if %}</div>',
      'sections/ok.liquid': '<div></div>',
      'config/x.json': '{ "a": 1, }',
      'config/y.json': '{ /* note */ "a": 1 }',
    });
    expect(index.liquid('sections/ok.liquid')).toBe(index.liquid('sections/ok.liquid'));
    expect(index.liquid('sections/a.liquid')).toBeNull();
    expect(index.liquid('sections/none.liquid')).toBeNull();
    expect(index.json('config/x.json')).toBeUndefined();
    expect(index.json('config/y.json')).toEqual({ a: 1 });
    expect(index.json('config/y.json')).toEqual({ a: 1 });
    expect(index.json('config/none.json')).toBeUndefined();
  });
});

describe('sectionInstances', () => {
  const index = theme({
    'templates/product.json': JSON.stringify({
      sections: {
        main: {
          type: 'main-product',
          settings: { accent: '#123456' },
          blocks: {
            'b/1': { type: 'price', blocks: { inner: { type: 'badge' } } },
            b2: { type: 'title' },
            bad: 'not a block',
          },
        },
      },
    }),
    'sections/footer-group.json': JSON.stringify({
      sections: { footer: { type: 'footer', settings: {} } },
    }),
    'sections/announcement.liquid': '<div></div>',
    'config/settings_data.json': '{}',
  });

  it('resolves a template section with the pointer of each block, nested ones included', () => {
    const [only, ...rest] = sectionInstances(index, 'shopify-section-template--9__main', 'product');
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      type: 'main-product',
      file: 'sections/main-product.liquid',
      jsonFile: 'templates/product.json',
      pointer: '/sections/main',
      origin: 'template',
    });
    expect(only?.blocks).toEqual([
      { type: 'price', pointer: '/sections/main/blocks/b~11' },
      { type: 'badge', pointer: '/sections/main/blocks/b~11/blocks/inner' },
      { type: 'title', pointer: '/sections/main/blocks/b2' },
    ]);
  });

  it('resolves a section group by key whatever the prefix', () => {
    const [only] = sectionInstances(index, 'shopify-section-sections--3__footer', 'product');
    expect(only).toMatchObject({
      type: 'footer',
      jsonFile: 'sections/footer-group.json',
      origin: 'group',
    });
  });

  it('tries every __ as the split', () => {
    const odd = theme({
      'templates/index.json': JSON.stringify({ sections: { a__b: { type: 'x' } } }),
    });
    const found = sectionInstances(odd, 'shopify-section-template--1__a__b', 'index');
    expect(found.map((i) => i.pointer)).toEqual(['/sections/a__b']);
  });

  it('resolves a static section by file name', () => {
    const [only] = sectionInstances(index, 'shopify-section-announcement', 'product');
    expect(only).toMatchObject({
      type: 'announcement',
      file: 'sections/announcement.liquid',
      origin: 'static',
      pointer: '/current/sections/announcement',
    });
  });

  it('finds nothing for an unknown key, a missing section file, or a template that is not JSON', () => {
    expect(sectionInstances(index, 'shopify-section-template--9__nope', 'product')).toEqual([]);
    expect(sectionInstances(index, 'shopify-section-gone', 'product')).toEqual([]);
    expect(sectionInstances(index, 'template--9__main', 'collection')).toEqual([]);
  });
});

describe('settingText', () => {
  const index = theme({
    'config/settings_data.json': JSON.stringify({
      current: 'Default',
      presets: { Default: { accent: '#0a0a0a', count: 3, flag: true } },
    }),
    'templates/index.json': JSON.stringify({
      sections: { hero: { type: 'hero', settings: { title: 'Hello', n: 2 } } },
    }),
  });
  const [hero] = sectionInstances(index, 'shopify-section-template--1__hero', 'index');

  it('reads global settings from the preset that current names', () => {
    expect(settingText(index, 'settings.accent', null)).toBe('#0a0a0a');
    expect(settingText(index, 'settings.count', null)).toBe('3');
    expect(settingText(index, 'settings.flag', null)).toBeUndefined();
    expect(settingText(index, 'settings.missing', null)).toBeUndefined();
  });

  it('reads global settings stored directly under current', () => {
    const direct = theme({ 'config/settings_data.json': '{"current":{"accent":"red"}}' });
    expect(settingText(direct, 'settings.accent', null)).toBe('red');
  });

  it('reads section settings from the instance, and nothing without one', () => {
    expect(settingText(index, 'section.settings.title', hero ?? null)).toBe('Hello');
    expect(settingText(index, 'section.settings.n', hero ?? null)).toBe('2');
    expect(settingText(index, 'section.settings.title', null)).toBeUndefined();
    expect(settingText(index, 'block.settings.title', hero ?? null)).toBeUndefined();
  });
});

describe('layoutFor', () => {
  it('uses the template layout key, with or without .liquid, else theme', () => {
    const index = theme({
      'templates/password.json': '{"layout":"password"}',
      'templates/gift.json': '{"layout":"gift.liquid"}',
      'templates/bare.json': '{"layout":false,"sections":{}}',
      'templates/index.json': '{"sections":{}}',
      'templates/page.liquid': '',
    });
    expect(layoutFor(index, 'password')).toBe('layout/password.liquid');
    expect(layoutFor(index, 'gift')).toBe('layout/gift.liquid');
    expect(layoutFor(index, 'index')).toBe('layout/theme.liquid');
    expect(layoutFor(index, 'page')).toBe('layout/theme.liquid');
  });

  it('is null for a template that renders without a layout', () => {
    const index = theme({ 'templates/bare.json': '{"layout":false,"sections":{}}' });
    expect(layoutFor(index, 'bare')).toBeNull();
  });
});

describe('renderClosure', () => {
  const index = theme({
    'sections/main.liquid': `{% render 'a' %}{% include 'b' %}{% content_for 'block', type: 'card', id: 'c1' %}{% content_for 'blocks' %}`,
    'snippets/a.liquid': `{% render 'c' %}`,
    'snippets/b.liquid': '<i></i>',
    'snippets/c.liquid': `{% render 'a' %}`,
    'blocks/card.liquid': '<div></div>',
    'blocks/slide.liquid': '<div></div>',
    'sections/loop.liquid': `{% section 'main' %}{% sections 'footer-group' %}`,
    'sections/dynamic.liquid': `{% render 'ghost' %}{% render name %}{% content_for 'block', type: kind %}{% content_for kind %}{% section name %}`,
  });

  it('follows render, include and content_for, once each, in the order reached', () => {
    const { files, dynamic } = renderClosure(index, ['sections/main.liquid'], {
      blockTypes: ['slide'],
    });
    expect(files).toEqual([
      'sections/main.liquid',
      'snippets/a.liquid',
      'snippets/b.liquid',
      'blocks/card.liquid',
      'blocks/slide.liquid',
      'snippets/c.liquid',
    ]);
    expect(dynamic).toBe(false);
  });

  it('follows {% section %} only on request', () => {
    expect(renderClosure(index, ['sections/loop.liquid']).files).toEqual(['sections/loop.liquid']);
    const { files } = renderClosure(index, ['sections/loop.liquid'], { followSections: true });
    expect(files).toContain('sections/main.liquid');
    expect(files).toContain('snippets/a.liquid');
  });

  it('flags a target named by a variable as dynamic and skips files that are not there', () => {
    const { files, dynamic } = renderClosure(index, ['sections/dynamic.liquid'], {
      followSections: true,
    });
    expect(dynamic).toBe(true);
    expect(files).toEqual(['sections/dynamic.liquid']);
  });
});

describe('searchElements', () => {
  const html = (body: string) => theme({ 'sections/s.liquid': body });
  const search = (
    body: string,
    el: ReturnType<typeof rendered>,
    resolve?: (l: string) => string | undefined,
  ) => searchElements(html(body), ['sections/s.liquid'], el, resolve);

  it('treats Liquid output in a value as a wildcard and compares text literally', () => {
    const body = `<a class="btn {{ extra }}" href="/p/{{ handle }}" title="A &amp; B">Go</a>`;
    const ok = rendered('a', { class: 'btn big', href: '/p/x', title: 'A & B' }, 'Go', []);
    expect(search(body, ok).matched).toHaveLength(1);
    const wrong = rendered('a', { class: 'btn big', href: '/q/x', title: 'A & B' }, 'Go', []);
    expect(search(body, wrong).matched).toHaveLength(0);
  });

  it('collapses whitespace in class and style values', () => {
    const body = `<div class="a   b" style="color:red;
      margin:0"></div>`;
    const el = rendered('div', { class: 'a b', style: 'color:red; margin:0' }, '', []);
    expect(search(body, el).matched).toHaveLength(1);
  });

  it('requires an attribute the source names unless a Liquid tag may have left it out', () => {
    const plain = rendered('a', { href: '/' }, '', []);
    expect(search(`<a href="/" class="x"></a>`, plain).matched).toHaveLength(0);
    expect(search(`<a href="/" {% if x %}class="x"{% endif %}></a>`, plain).matched).toHaveLength(
      1,
    );
  });

  it('allows attributes the AST cannot see only when the tag prints attributes through Liquid', () => {
    const el = rendered('div', { 'data-block-id': 'abc', class: 'x' }, '', []);
    expect(search(`<div class="x"></div>`, el).matched).toHaveLength(0);
    expect(search(`<div class="x" {{ block.shopify_attributes }}></div>`, el).matched).toHaveLength(
      1,
    );
  });

  it('matches character references and numeric references in text', () => {
    const body = `<p>Fish &amp; chips &#169; &#xA9; &nbsp;&unknown;</p>`;
    const el = rendered('p', {}, 'Fish & chips © © &unknown;', []);
    expect(search(body, el).matched).toHaveLength(1);
  });

  it('uses the resolver for a plain setting lookup and a wildcard otherwise', () => {
    const body = `<a href="{{ section.settings.link }}" class="l"></a>`;
    const el = rendered('a', { href: '/x', class: 'l' }, '', []);
    expect(search(body, el, () => '/x').matched).toHaveLength(1);
    expect(search(body, el, () => '/y').matched).toHaveLength(0);
    expect(search(body, el, () => undefined).matched).toHaveLength(1);
    expect(search(body, el).matched).toHaveLength(1);
    const filtered = `<a href="{{ section.settings.link | escape }}" class="l"></a>`;
    expect(search(filtered, el, () => '/y').matched).toHaveLength(1);
  });

  it('keeps elements under other ancestors apart from real matches', () => {
    const body = `<div class="one"><b class="x"></b></div><div class="two"><b class="x"></b></div>`;
    const el = rendered('b', { class: 'x' }, '', [node('div', { class: 'two' })]);
    const result = search(body, el);
    expect(result.matched).toHaveLength(1);
    expect(result.elsewhere).toHaveLength(1);
    expect(result.matched[0]?.reasons).toContain('ancestors agree');
  });

  it('does not match an element whose tag name is partly Liquid', () => {
    const el = rendered('h2', {}, '', []);
    expect(search(`<h{{ level }}>x</h{{ level }}>`, el).matched).toHaveLength(0);
  });
});
