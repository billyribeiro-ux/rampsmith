/**
 * The CSS index and the cascade (ADR-245): declarations carry offsets in the original file even
 * when Liquid sits inside the CSS, the load order is the layout's, and the cascade picks the
 * winner by importance, inline style, specificity and order, saying so when it is unsure.
 */
import { describe, expect, it } from 'vitest';
import { cascade } from '../src/map/css/cascade.ts';
import { buildCssIndex, sanitizeLiquid, type CssIndex } from '../src/map/css/index.ts';
import { ThemeIndex } from '../src/map/theme.ts';
import type { RenderedNode } from '../src/map/types.ts';

const LAYOUT = `<!doctype html>
<html lang="en">
<head>
  <style>
    p { color: #111; }
  </style>
  {{ 'base.css' | asset_url | stylesheet_tag }}
  {{ content_for_header }}
  {% style %}
    :root { --brand: {{ settings.brand }}; }
  {% endstyle %}
</head>
<body>{{ content_for_layout }}</body>
</html>
`;

const SECTION = `{% stylesheet %}
  .card p { color: #222; }
{% endstylesheet %}
<div class="card"><p>Hi</p></div>
<style>
  .card .late { color: #333 !important; }
</style>
`;

function theme(files: Record<string, string>): ThemeIndex {
  return new ThemeIndex(new Map(Object.entries(files)));
}

function find(css: CssIndex, selector: string) {
  const rule = css.rules.find((r) => r.selectorText === selector);
  if (rule === undefined) throw new Error(`no rule ${selector}`);
  return rule;
}

describe('sanitizeLiquid', () => {
  it('replaces output and tags with filler of the same length', () => {
    const text = 'a { color: {{ settings.c }}; {% if x %}b: c;{% endif %} }';
    const clean = sanitizeLiquid(text);
    expect(clean).toHaveLength(text.length);
    expect(clean).not.toMatch(/\{\{|\{%|%\}|\}\}/u);
    expect(clean).toBe('a { color: ________________; __________b: c;___________ }');
  });
});

describe('buildCssIndex', () => {
  const files = {
    'layout/theme.liquid': LAYOUT,
    'sections/card.liquid': SECTION,
    'assets/base.css': 'p { color: #000; }\n.card p { color: #444; margin: 0 }\n',
  };
  const index = theme(files);
  const css = buildCssIndex(index, 'layout/theme.liquid', ['sections/card.liquid']);

  it('reads <style>, linked assets, {% style %}, {% stylesheet %} and section <style> tags', () => {
    expect(css.unparsed).toEqual([]);
    expect(css.rules.map((r) => `${r.file}: ${r.selectorText}`)).toEqual([
      'layout/theme.liquid: p',
      'assets/base.css: p',
      'assets/base.css: .card p',
      'sections/card.liquid: .card p',
      'layout/theme.liquid: :root',
      'sections/card.liquid: .card .late',
    ]);
  });

  it('orders rules the way the page loads them', () => {
    const orders = css.rules.map((r) => r.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('gives each declaration offsets in the original file, from the property to the value end', () => {
    const rule = find(css, '.card .late');
    const [decl] = rule.declarations;
    expect(decl?.property).toBe('color');
    expect(decl?.important).toBe(true);
    const source = files['sections/card.liquid'];
    expect(source.slice(decl?.start, decl?.end)).toBe('color: #333 !important');
    expect(source.slice(decl?.valueStart, decl?.valueEnd)).toBe('#333');
    expect(decl?.value).toBe('#333');
    const asset = files['assets/base.css'];
    const base = find(css, '.card p').declarations;
    expect(base.map((d) => asset.slice(d.start, d.end))).toEqual(['color: #444', 'margin: 0']);
  });

  it('keeps the original text of a value that holds Liquid', () => {
    const [decl] = find(css, ':root').declarations;
    expect(decl?.property).toBe('--brand');
    expect(decl?.value).toBe('{{ settings.brand }}');
    expect(files['layout/theme.liquid'].slice(decl?.valueStart, decl?.valueEnd)).toBe(
      '{{ settings.brand }}',
    );
  });

  it('reads .css.liquid assets', () => {
    const withLiquid = theme({
      'layout/theme.liquid': `{{ 'a.css' | asset_url | stylesheet_tag }}`,
      'assets/a.css.liquid': 'a { color: {{ settings.link }}; }',
    });
    const index2 = buildCssIndex(withLiquid, 'layout/theme.liquid', []);
    expect(index2.rules.map((r) => r.selectorText)).toEqual(['a']);
    expect(index2.rules[0]?.declarations[0]?.value).toBe('{{ settings.link }}');
  });

  it('ignores non-CSS assets, missing assets and CSS it cannot parse', () => {
    const odd = theme({
      'layout/theme.liquid': `{{ 'app.js' | asset_url }}{{ 'gone.css' | asset_url }}<style>a { color: red </style>`,
      'assets/app.js': 'a { color: red }',
    });
    const result = buildCssIndex(odd, 'layout/theme.liquid', []);
    expect(result.rules).toEqual([]);
    expect(result.unparsed.length).toBe(1);
  });

  it('evaluates media queries at the scanner viewport and drops what cannot apply', () => {
    const media = theme({
      'layout/theme.liquid': `<style>
        @media (max-width: 749px) { .m { color: red } }
        @media (min-width: 750px) { .w { color: red } }
        @media print { .p { color: red } }
        @media screen and (min-width: 750px), print { .s { color: red } }
        @media (prefers-color-scheme: dark) { .d { color: red } }
        @supports (display: grid) { .g { color: red } }
        @keyframes k { from { color: red } to { color: blue } }
        @font-face { font-family: x; src: url(x) }
      </style>`,
    });
    const result = buildCssIndex(media, 'layout/theme.liquid', []);
    const byName = Object.fromEntries(result.rules.map((r) => [r.selectorText, r.conditional]));
    expect(byName).toEqual({ '.w': false, '.s': false, '.d': true, '.g': false });
  });
});

describe('cascade', () => {
  const sheet = `<style>
    body { color: #111 }
    a { color: #222 }
    .nav a { color: #333 }
    a.cta { color: #444 }
    a.cta { color: #555 }
    #hero a { color: #666 !important }
    a.cta { color: #777 }
    p { color: inherit }
    .uses-has:has(img) { color: #888 }
  </style>`;
  const css = buildCssIndex(theme({ 'layout/theme.liquid': sheet }), 'layout/theme.liquid', []);
  const body: RenderedNode = { tag: 'body', attributes: {} };

  function chain(...nodes: RenderedNode[]): RenderedNode[] {
    return [...nodes, body];
  }

  it('picks the most specific rule, and the later of two equal ones', () => {
    const a: RenderedNode = { tag: 'a', attributes: { class: 'cta' } };
    const result = cascade(css, chain(a), ['color'], { inherited: true });
    expect(result.winner?.declaration.value).toBe('#777');
    expect(result.level).toBe(0);
    expect(result.uncertain).toBe(false);
    const inNav = cascade(css, chain(a, { tag: 'nav', attributes: { class: 'nav' } }), ['color'], {
      inherited: true,
    });
    // `a.cta` (0,1,1) beats `.nav a` (0,1,1) only by order: the later rule wins.
    expect(inNav.winner?.declaration.value).toBe('#777');
  });

  it('lets !important beat specificity', () => {
    const a: RenderedNode = { tag: 'a', attributes: { class: 'cta' } };
    const hero: RenderedNode = { tag: 'div', attributes: { id: 'hero' } };
    const result = cascade(css, chain(a, hero), ['color'], { inherited: true });
    expect(result.winner?.declaration.value).toBe('#666');
    expect(result.winner?.declaration.important).toBe(true);
  });

  it('inherits an inherited property from the nearest ancestor that sets it', () => {
    const span: RenderedNode = { tag: 'span', attributes: {} };
    const result = cascade(css, chain(span), ['color'], { inherited: true });
    expect(result.winner?.declaration.value).toBe('#111');
    expect(result.level).toBe(1);
    const own = cascade(css, chain(span), ['color'], { inherited: false });
    expect(own.winner).toBeNull();
  });

  it('follows `inherit` to the parent', () => {
    const p: RenderedNode = { tag: 'p', attributes: {} };
    const result = cascade(css, chain(p), ['color'], { inherited: true });
    expect(result.winner?.declaration.value).toBe('#111');
    expect(result.notes.some((n) => n.includes('inherit'))).toBe(true);
  });

  it('lets an inline declaration read from the source beat any rule but !important', () => {
    const a: RenderedNode = { tag: 'a', attributes: { class: 'cta', style: 'color: #abc' } };
    const inline = [
      {
        file: 'sections/x.liquid',
        property: 'color',
        value: '#abc',
        start: 1,
        end: 12,
        valueStart: 8,
        valueEnd: 12,
        important: false,
      },
    ];
    const result = cascade(css, chain(a), ['color'], { inherited: true, inline });
    expect(result.winner?.declaration.value).toBe('#abc');
    expect(result.winner?.rule).toBeNull();
    expect(result.uncertain).toBe(false);
  });

  it('doubts an inline style it was not given the source of', () => {
    const a: RenderedNode = { tag: 'a', attributes: { class: 'cta', style: 'color: #abc' } };
    const result = cascade(css, chain(a), ['color'], { inherited: true });
    expect(result.uncertain).toBe(true);
  });

  it('marks the answer uncertain when a rule that could win depends on something unrecorded', () => {
    const el: RenderedNode = { tag: 'div', attributes: { class: 'uses-has' } };
    const result = cascade(css, chain(el), ['color'], { inherited: true });
    expect(result.uncertain).toBe(true);
    expect(result.notes[0]).toContain('.uses-has:has(img)');
  });

  it('matches a focus rule only when asked about focus', () => {
    const focusCss = buildCssIndex(
      theme({
        'layout/theme.liquid': '<style>a:focus { outline: none } a { outline: 1px solid }</style>',
      }),
      'layout/theme.liquid',
      [],
    );
    const a: RenderedNode = { tag: 'a', attributes: {} };
    const rest = cascade(focusCss, [a], ['outline'], { inherited: false });
    expect(rest.winner?.declaration.value).toBe('1px solid');
    const focused = cascade(focusCss, [a], ['outline'], {
      inherited: false,
      match: { focus: true },
    });
    expect(focused.winner?.declaration.value).toBe('none');
  });

  it('makes a rule inside an unsettled at-rule a doubt, not a winner', () => {
    const conditional = buildCssIndex(
      theme({
        'layout/theme.liquid':
          '<style>a { color: #111 } @media (prefers-color-scheme: dark) { a { color: #eee } }</style>',
      }),
      'layout/theme.liquid',
      [],
    );
    const result = cascade(conditional, [{ tag: 'a', attributes: {} }], ['color'], {
      inherited: true,
    });
    expect(result.winner?.declaration.value).toBe('#111');
    expect(result.uncertain).toBe(true);
  });
});
