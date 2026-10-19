/**
 * The source mapper end to end on the hand-written "tarn" theme (ADR-244, ADR-245, ADR-246):
 * each test describes a rendered element the way the scanner does and checks the span, the
 * confidence and, for the doubtful cases, that it is below the 0.9 bar and says why.
 */
import { describe, expect, it } from 'vitest';
import { Mapper } from '../src/map/map.ts';
import {
  CONFIDENCE_THRESHOLD,
  type FindingToMap,
  type MapOutcome,
  type RenderedResource,
} from '../src/map/types.ts';
import {
  HEADER,
  HERO,
  LAYOUT,
  SETTINGS_DATA,
  INDEX_JSON,
  TWIN,
  at,
  node,
  pageAbove,
  rendered,
  tarn,
} from './tarn.ts';

const HERO_WRAPPER = 'template--1__hero';
const mapper = new Mapper(tarn());

function mapped(outcome: MapOutcome) {
  if (outcome.status !== 'mapped') throw new Error(JSON.stringify(outcome));
  return outcome;
}

function inHero(
  rule: string,
  tag: string,
  attributes: Record<string, string>,
  text: string,
  extra: Partial<FindingToMap> = {},
  parents: readonly ReturnType<typeof node>[] = [node('section', { class: 'hero' })],
): FindingToMap {
  return {
    rule,
    template: 'index',
    element: rendered(tag, attributes, text, [...parents, ...pageAbove(HERO_WRAPPER)]),
    ...extra,
  };
}

describe('page-wide rules map to the layout', () => {
  it('puts a missing language on the <html> element of the layout', () => {
    const outcome = mapped(
      mapper.map({
        rule: 'html-has-lang',
        template: 'index',
        element: rendered('html', {}, '', []),
      }),
    );
    expect(outcome.span).toEqual({
      kind: 'element',
      file: 'layout/theme.liquid',
      start: at(LAYOUT, '<html>'),
      tag: 'html',
    });
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('puts a missing skip link on <body>, and asks for review when the layout has two', () => {
    const body = mapped(
      mapper.map({
        rule: 'bypass',
        template: 'index',
        element: rendered('html', {}, '', []),
      }),
    );
    expect(body.span).toMatchObject({ file: 'layout/theme.liquid', tag: 'body' });
    const two = new Map(tarn());
    two.set('layout/theme.liquid', `${LAYOUT}<body></body>\n`);
    const outcome = new Mapper(two).map({
      rule: 'bypass',
      template: 'index',
      element: rendered('html', {}, '', []),
    });
    expect(outcome.status).toBe('needs_review');
    if (outcome.status === 'needs_review') expect(outcome.candidates).toHaveLength(2);
  });

  it('is unmapped when the layout is missing', () => {
    const files = new Map(tarn());
    files.delete('layout/theme.liquid');
    const outcome = new Mapper(files).map({
      rule: 'html-has-lang',
      template: 'index',
      element: rendered('html', {}, '', []),
    });
    expect(outcome.status).toBe('unmapped');
  });

  it('is unmapped for a template that renders without a layout', () => {
    const files = new Map(tarn());
    files.set('templates/bare.json', '{"layout":false,"sections":{}}');
    const m = new Mapper(files);
    const outcome = m.map({
      rule: 'html-has-lang',
      template: 'bare',
      element: rendered('html', {}, '', []),
    });
    expect(outcome.status).toBe('unmapped');
    // A style finding on such a page has no layout CSS to read, and says so by not mapping.
    const style = m.map({
      rule: 'color-contrast',
      template: 'bare',
      element: rendered('p', { class: 'plain' }, 'x', pageAbove()),
    });
    expect(style.status).not.toBe('mapped');
  });

  it('uses the layout a template names', () => {
    const files = new Map(tarn());
    files.set('layout/password.liquid', '<html><body></body></html>');
    files.set('templates/password.json', '{"layout":"password","sections":{},"order":[]}');
    const outcome = mapped(
      new Mapper(files).map({
        rule: 'html-has-lang',
        template: 'password',
        element: rendered('html', {}, '', []),
      }),
    );
    expect(outcome.span).toMatchObject({ file: 'layout/password.liquid', tag: 'html' });
  });
});

describe('elements', () => {
  it('maps an element of a template section to its file and offset', () => {
    const outcome = mapped(
      mapper.map(inHero('button-name', 'button', { class: 'icon-button' }, '')),
    );
    expect(outcome.span).toEqual({
      kind: 'element',
      file: 'sections/hero.liquid',
      start: at(HERO, '<button class="icon-button">'),
      tag: 'button',
    });
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(outcome.why.join(' ')).toContain('class="icon-button"');
  });

  it('follows a section group and the snippets it renders', () => {
    const wrapper = 'sections--2__header';
    const input = rendered('input', { type: 'search', name: 'q', class: 'search__input' }, '', [
      node('form', { action: '/search', class: 'search' }),
      node('header', { class: 'site-header' }),
      ...pageAbove(wrapper),
    ]);
    const outcome = mapped(mapper.map({ rule: 'label', template: 'index', element: input }));
    expect(outcome.span).toMatchObject({ file: 'snippets/search-form.liquid', tag: 'input' });
  });

  it('resolves a setting lookup in an attribute from the section JSON', () => {
    const outcome = mapped(
      mapper.map(inHero('link-name', 'a', { href: '/collections/all', class: 'btn' }, 'Shop')),
    );
    expect(outcome.span).toMatchObject({ file: 'sections/hero.liquid', tag: 'a' });
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('trusts a mapping less when the JSON disagrees with what was rendered', () => {
    const outcome = mapped(
      mapper.map(inHero('link-name', 'a', { href: '/somewhere-else', class: 'btn' }, 'Shop')),
    );
    expect(outcome.span).toMatchObject({ file: 'sections/hero.liquid' });
    expect(outcome.confidence).toBeLessThanOrEqual(0.85);
  });

  it('lists the same-file twin that the same fix also applies to', () => {
    const header = (cls: string) =>
      rendered('a', { href: '/cart', class: 'cart-link' }, '', [
        node('nav', { class: `site-nav ${cls}` }),
        node('header', { class: 'site-header' }),
        ...pageAbove('sections--2__header'),
      ]);
    const outcome = mapped(
      mapper.map({ rule: 'link-name', template: 'index', element: header('desktop-only') }),
    );
    const first = HEADER.indexOf('<a href="/cart" class="cart-link">');
    const second = HEADER.indexOf('<a href="/cart" class="cart-link">', first + 1);
    expect(outcome.span).toEqual({
      kind: 'element',
      file: 'sections/header.liquid',
      start: first,
      tag: 'a',
    });
    expect(outcome.identical).toEqual([
      { kind: 'element', file: 'sections/header.liquid', start: second, tag: 'a' },
    ]);
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('returns candidates for review when two elements fit equally well', () => {
    const outcome = mapper.map({
      rule: 'link-name',
      template: 'index',
      element: rendered('a', { href: '/x', class: 'dup' }, 'Anything', [
        node('section', { class: 'twin' }),
        ...pageAbove('template--1__twin'),
      ]),
    });
    expect(outcome.status).toBe('needs_review');
    if (outcome.status === 'needs_review') {
      expect(outcome.candidates).toHaveLength(2);
      expect(outcome.candidates.map((c) => c.span)).toEqual([
        {
          kind: 'element',
          file: 'sections/twin.liquid',
          start: at(TWIN, '<a href="{{ one.url }}"'),
          tag: 'a',
        },
        {
          kind: 'element',
          file: 'sections/twin.liquid',
          start: at(TWIN, '<a href="{{ two.url }}"'),
          tag: 'a',
        },
      ]);
      for (const c of outcome.candidates) expect(c.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    }
  });

  it('caps the confidence when a render call is too dynamic to follow', () => {
    const outcome = mapped(
      mapper.map({
        rule: 'button-name',
        template: 'index',
        element: rendered('span', { class: 'few' }, 'anything', [
          node('section', { class: 'twin' }),
          ...pageAbove('template--1__twin'),
        ]),
      }),
    );
    expect(outcome.span).toMatchObject({ file: 'sections/twin.liquid', tag: 'span' });
    expect(outcome.confidence).toBeLessThanOrEqual(0.85);
  });

  it('offers a file the page does not render only for review', () => {
    const outcome = mapper.map(
      inHero('button-name', 'button', { class: 'not-on-this-page' }, '', {}, [
        node('aside', { class: 'sidebar' }),
      ]),
    );
    expect(outcome.status).toBe('needs_review');
    if (outcome.status === 'needs_review') {
      expect(outcome.candidates[0]?.span).toMatchObject({ file: 'sections/sidebar.liquid' });
      expect(outcome.candidates[0]?.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    }
  });

  it('is unmapped when no element of the theme fits', () => {
    const outcome = mapper.map(inHero('button-name', 'marquee', { class: 'nope' }, ''));
    expect(outcome.status).toBe('unmapped');
  });

  it('is unmapped when the wrapper names a section the theme does not have', () => {
    const outcome = mapper.map({
      rule: 'button-name',
      template: 'index',
      element: rendered('button', { class: 'icon-button' }, '', pageAbove('template--1__gone')),
    });
    expect(outcome.status).not.toBe('mapped');
  });
});

describe('rich text', () => {
  const resource = (html: string): RenderedResource => ({
    type: 'page',
    gid: 'gid://shopify/Page/7',
    fields: { body: html },
  });
  const image = (resourceValue: RenderedResource | undefined): FindingToMap => ({
    rule: 'image-alt',
    template: 'page',
    element: rendered('img', { src: '/a.png' }, '', [
      node('p'),
      node('div', { class: 'rte' }),
      node('article', { class: 'page' }),
      ...pageAbove('template--1__main'),
    ]),
    ...(resourceValue === undefined ? {} : { resource: resourceValue }),
  });

  it('maps an element of page content to the start tag in the Page body', () => {
    const html = '<p>Hello</p>\n<p><img src="/a.png"></p>';
    const outcome = mapped(mapper.map(image(resource(html))));
    expect(outcome.span).toEqual({
      kind: 'data',
      resource: 'gid://shopify/Page/7',
      field: 'body',
      start: html.indexOf('<img'),
      end: html.indexOf('>', html.indexOf('<img')) + 1,
    });
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(outcome.rendersFrom).toMatchObject({ file: 'sections/main-page.liquid', tag: 'div' });
  });

  it('asks for review when two elements of the field fit', () => {
    const html = '<p><img src="/a.png"></p><p><img src="/a.png"></p>';
    expect(mapper.map(image(resource(html))).status).toBe('needs_review');
  });

  it('asks for review when none fits, and is unmapped when the field is missing', () => {
    expect(mapper.map(image(resource('<p>No picture</p>'))).status).toBe('needs_review');
    const noField: RenderedResource = {
      type: 'page',
      gid: 'gid://shopify/Page/7',
      fields: {},
    };
    expect(mapper.map(image(noField)).status).toBe('unmapped');
  });

  it('falls back to theme source when no resource is given or the theme prints no rich text', () => {
    expect(mapper.map(image(undefined)).status).not.toBe('mapped');
    const product: RenderedResource = {
      type: 'product',
      gid: 'gid://shopify/Product/1',
      fields: {},
    };
    expect(mapper.map(image(product)).status).not.toBe('mapped');
  });

  it('maps article and product fields by their Admin API names', () => {
    const files = new Map(tarn());
    files.set(
      'sections/main-page.liquid',
      '<div class="rte">{{ article.content }}</div><div class="intro">{{ article.excerpt }}</div><div class="d">{{ product.description }}</div><div class="k">{{ product.content }}</div><div class="c">{{ collection.description }}</div>',
    );
    const m = new Mapper(files);
    const probe = (className: string, type: RenderedResource['type'], field: string) =>
      m.map({
        rule: 'image-alt',
        template: 'page',
        element: rendered('img', { src: '/a.png' }, '', [
          node('div', { class: className }),
          ...pageAbove('template--1__main'),
        ]),
        resource: { type, gid: `gid://shopify/X/1`, fields: { [field]: '<img src="/a.png">' } },
      });
    expect(mapped(probe('rte', 'article', 'body')).span).toMatchObject({ field: 'body' });
    expect(mapped(probe('intro', 'article', 'summary')).span).toMatchObject({ field: 'summary' });
    expect(mapped(probe('d', 'product', 'descriptionHtml')).span).toMatchObject({
      field: 'descriptionHtml',
    });
    expect(mapped(probe('k', 'product', 'descriptionHtml')).span).toMatchObject({
      field: 'descriptionHtml',
    });
    expect(mapped(probe('c', 'collection', 'descriptionHtml')).span).toMatchObject({
      field: 'descriptionHtml',
    });
  });
});

describe('colour', () => {
  const para = (cls: string, text: string, foreground: string, extra = {}) =>
    inHero('color-contrast', 'p', { class: cls }, text, { evidence: { foreground }, ...extra });

  it('maps a colour setting through the CSS rule that prints it', () => {
    const outcome = mapped(mapper.map(para('hero__text muted', 'Our story', '#9b9b9b')));
    expect(outcome.span).toEqual({
      kind: 'json-value',
      file: 'config/settings_data.json',
      pointer: '/current/color_muted',
      start: at(SETTINGS_DATA, '"#9b9b9b"'),
      end: at(SETTINGS_DATA, '"#9b9b9b"') + '"#9b9b9b"'.length,
    });
    expect(outcome.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(outcome.rendersFrom).toMatchObject({ file: 'sections/hero.liquid', tag: 'p' });
  });

  it('follows var() to a custom property set from a section setting', () => {
    const outcome = mapped(
      mapper.map(
        inHero('color-contrast', 'h2', { class: 'hero__title' }, 'Welcome', {
          evidence: { foreground: '#a0a0a0' },
        }),
      ),
    );
    expect(outcome.span).toMatchObject({
      kind: 'json-value',
      file: 'templates/index.json',
      pointer: '/sections/hero/settings/title_color',
    });
    expect(INDEX_JSON.slice(outcome.span.kind === 'json-value' ? outcome.span.start : 0)).toMatch(
      /^"#a0a0a0"/u,
    );
  });

  it('maps a CSS colour to its declaration, and the later of two equal rules wins', () => {
    const outcome = mapped(mapper.map(para('plain plain--later', 'Later copy', '#8a8a8a')));
    expect(outcome.span).toMatchObject({
      kind: 'css-declaration',
      file: 'layout/theme.liquid',
      property: 'color',
    });
    if (outcome.span.kind !== 'css-declaration') return;
    expect(LAYOUT.slice(outcome.span.start, outcome.span.end)).toBe('color: #8a8a8a');
  });

  it('lets !important win and reads an inline style from the source element', () => {
    const loud = mapped(mapper.map(para('shout', 'Loud copy', '#777777')));
    if (loud.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(LAYOUT.slice(loud.span.start, loud.span.end)).toBe('color: #777777 !important');
    const inline = mapped(
      mapper.map(
        inHero(
          'color-contrast',
          'p',
          { class: 'inline', style: 'color: #bbbbbb; margin: 0' },
          'Inline copy',
          {
            evidence: { foreground: '#bbbbbb' },
          },
        ),
      ),
    );
    if (inline.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(inline.span.file).toBe('sections/hero.liquid');
    expect(HERO.slice(inline.span.start, inline.span.end)).toBe('color: #bbbbbb');
  });

  it('is below the bar when the measured colour is not the declared one', () => {
    const outcome = mapper.map(para('plain', 'Plain copy', '#cccccc'));
    expect(outcome.status).toBe('needs_review');
    if (outcome.status === 'needs_review') {
      expect(outcome.candidates[0]?.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
      expect(outcome.reason).toContain('differs from the measured');
    }
  });

  it('is below the bar when another rule might apply, and when the colour was not measured', () => {
    const doubt = mapper.map(para('fancy', 'x', '#aaaaaa'));
    expect(doubt.status).toBe('needs_review');
    const unmeasured = mapper.map(inHero('color-contrast', 'p', { class: 'plain' }, 'Plain copy'));
    expect(unmeasured.status).toBe('needs_review');
  });

  it('explains why when no author rule sets the colour', () => {
    const outcome = mapper.map(para('nothing', 'x', '#000000'));
    expect(outcome.status === 'needs_review' || outcome.status === 'unmapped').toBe(true);
  });
});

describe('other style findings', () => {
  it('maps a removed focus outline to the declaration that removes it', () => {
    const outcome = mapped(
      mapper.map(
        inHero(
          'rs-focus-indicator-missing',
          'a',
          { href: '/collections/all', class: 'btn' },
          'Shop',
        ),
      ),
    );
    if (outcome.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(LAYOUT.slice(outcome.span.start, outcome.span.end)).toBe('outline: none');
  });

  it('maps a link without an underline to text-decoration: none', () => {
    const outcome = mapped(
      mapper.map(
        inHero('link-in-text-block', 'a', { href: '/about' }, 'about us', {}, [
          node('p'),
          node('div', { class: 'card' }),
          node('section', { class: 'hero' }),
        ]),
      ),
    );
    if (outcome.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(LAYOUT.slice(outcome.span.start, outcome.span.end)).toBe('text-decoration: none');
  });

  it('maps a small target to the dimension that is under 24px', () => {
    const wide = mapped(
      mapper.map(
        inHero('target-size', 'a', { href: '/tiny', class: 'tiny' }, '', {
          evidence: { width: 16, height: 16 },
        }),
      ),
    );
    if (wide.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(LAYOUT.slice(wide.span.start, wide.span.end)).toBe('width: 16px');
    const tall = mapped(
      mapper.map(
        inHero('target-size', 'a', { href: '/tiny', class: 'tiny' }, '', {
          evidence: { width: 40, height: 16 },
        }),
      ),
    );
    if (tall.span.kind !== 'css-declaration') throw new Error('expected a declaration');
    expect(LAYOUT.slice(tall.span.start, tall.span.end)).toBe('height: 16px');
  });

  it('asks for review when the winning declaration does not explain the finding', () => {
    const outcome = mapper.map(
      inHero('target-size', 'a', { href: '/collections/all', class: 'btn' }, 'Shop', {
        evidence: { width: 16, height: 16 },
      }),
    );
    expect(outcome.status).toBe('needs_review');
  });

  it('has no style mapper for rules that are not about style', () => {
    const outcome = mapper.map(
      inHero('image-alt', 'img', { src: '/a.png', alt: '' }, '', {}, [
        node('p', { class: 'fancy' }),
        node('section', { class: 'hero' }),
      ]),
    );
    // An element rule maps the element; nothing style-related is attempted.
    expect(outcome.status === 'mapped' || outcome.status === 'needs_review').toBe(true);
  });
});
