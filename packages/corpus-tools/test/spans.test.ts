import { describe, expect, it } from 'vitest';
import type { Span } from '../src/golden.ts';
import { loadStore } from '../src/render/store.ts';
import type { Theme } from '../src/render/theme.ts';
import {
  cssDeclaration,
  elementStarts,
  jsonValueAt,
  occurrencesOf,
  pointerPath,
  relocate,
  spanProblem,
  storeField,
} from '../src/spans.ts';

const liquid =
  '<div>\n  {% if x %}<a href="/cart" class="c">{% render \'icon\' %}</a>{% endif %}\n  <input\n    id="q">\n</div>\n';
const json = '{\n  "current": {\n    "color_text": "#9b9b9b",\n    "a/b": [1, "two"]\n  }\n}\n';
const css = '.a {\n  color: #a3a3a3;\n}\n.b {\n  outline: none;\n}\n';
const theme: Theme = {
  name: 't',
  files: new Map([
    ['sections/x.liquid', liquid],
    ['config/settings_data.json', json],
    ['assets/base.css', css],
  ]),
};
const store = loadStore('fixtures/store.json');

describe('pointerPath and jsonValueAt', () => {
  it('reads RFC 6901 pointers with escapes and array indexes', () => {
    expect(pointerPath('/current/a~1b/1')).toEqual(['current', 'a/b', '1']);
    expect(pointerPath('/x~0y')).toEqual(['x~y']);
    expect(() => pointerPath('current')).toThrow(/JSON Pointer/);
  });

  it('finds a value with its offsets', () => {
    const at = jsonValueAt(json, '/current/color_text');
    expect(at).not.toBeNull();
    expect(json.slice(at?.start, at?.end)).toBe('"#9b9b9b"');
    expect(
      json.slice(
        jsonValueAt(json, '/current/a~1b/1')?.start,
        jsonValueAt(json, '/current/a~1b/1')?.end,
      ),
    ).toBe('"two"');
    expect(jsonValueAt(json, '/current/missing')).toBeNull();
  });

  it('keeps all-digit tokens as object keys, as older themes number their blocks', () => {
    const blocks =
      '{"blocks":{"1585245264519":{"type":"slide"},"0":{"type":"text"}},"order":["a","b"]}';
    const slide = jsonValueAt(blocks, '/blocks/1585245264519/type');
    expect(blocks.slice(slide?.start, slide?.end)).toBe('"slide"');
    const zero = jsonValueAt(blocks, '/blocks/0/type');
    expect(blocks.slice(zero?.start, zero?.end)).toBe('"text"');
    const second = jsonValueAt(blocks, '/order/1');
    expect(blocks.slice(second?.start, second?.end)).toBe('"b"');
    expect(jsonValueAt(blocks, '/order/x')).toBeNull();
  });
});

describe('elementStarts', () => {
  it('lists start tags inside Liquid blocks, by offset', () => {
    const starts = elementStarts(liquid);
    expect(starts.get(liquid.indexOf('<a '))).toBe('a');
    expect(starts.get(liquid.indexOf('<input'))).toBe('input');
    expect(starts.get(0)).toBe('div');
    expect(starts.has(liquid.indexOf('{% render'))).toBe(false);
  });
});

describe('cssDeclaration', () => {
  it('finds a declaration inside the one rule with the selector', () => {
    const source =
      '.x a { color: red; }\n.y a { color: red; text-decoration: none; }\n.y a:hover { color: blue; }';
    expect(cssDeclaration(source, '.y a', 'color: red')).toBe(source.indexOf('color: red', 20));
    expect(cssDeclaration(source, '.y a', 'outline: 0')).toMatch(/has no declaration/);
    expect(cssDeclaration('.a{color:red}.a{color:red}', '.a', 'color:red')).toMatch(
      /more than one rule/,
    );
    expect(cssDeclaration('.a { color: red; color: red; }', '.a', 'color: red')).toMatch(
      /more than once/,
    );
  });

  it('does not find a declaration inside a longer property', () => {
    expect(cssDeclaration('.a { background-color: #777; }', '.a', 'color: #777')).toMatch(
      /has no declaration/,
    );
    const both = '.a { background-color: #777; color: #777; }';
    expect(cssDeclaration(both, '.a', 'color: #777')).toBe(both.lastIndexOf('color: #777'));
  });

  it('compares selectors whole: descendants and lists are other rules', () => {
    const source = '.card .btn { outline: 0; }\n.a,\n.btn { outline: 0; }\n.btn { outline: 0; }';
    expect(cssDeclaration(source, '.btn', 'outline: 0')).toBe(source.lastIndexOf('outline: 0'));
    expect(cssDeclaration(source, '.a, .btn', 'outline: 0')).toBe(source.indexOf('outline: 0', 30));
  });

  it('skips comments and Liquid, whose braces are not CSS braces', () => {
    const source =
      '/* x */.n { color: {{ settings.text }}; margin: 0; }\n{% if a %}.m { color: red; }{% endif %}';
    expect(cssDeclaration(source, '.n', 'margin: 0')).toBe(source.indexOf('margin: 0'));
    expect(cssDeclaration(source, '.m', 'color: red')).toBe(source.indexOf('color: red'));
  });

  it('finds a rule inside a section stylesheet tag and inside @media', () => {
    const section =
      '{% stylesheet %}\n  .note { color: #999; }\n{% endstylesheet %}\n<p class="note">x</p>\n{% schema %}{"name":"N","settings":[]}{% endschema %}';
    expect(cssDeclaration(section, '.note', 'color: #999')).toBe(section.indexOf('color: #999'));
    const media = '@media (min-width: 750px) { .x { width: 16px; } }';
    expect(cssDeclaration(media, '.x', 'width: 16px')).toBe(media.indexOf('width: 16px'));
  });
});

describe('occurrencesOf', () => {
  it('finds overlapping matches', () => {
    expect(occurrencesOf('aaa', 'aa')).toEqual([0, 1]);
    expect(occurrencesOf('abc', '')).toEqual([]);
  });
});

describe('storeField', () => {
  it('reads product, media, article and page fields', () => {
    expect(storeField(store, 'gid://shopify/MediaImage/9301', 'alt')).toBe('');
    expect(storeField(store, 'gid://shopify/Product/7001', 'descriptionHtml')).toContain(
      '<h4>Care</h4>',
    );
    expect(storeField(store, 'gid://shopify/Article/3001', 'body')).toContain('linen-drying.jpg');
    expect(storeField(store, 'gid://shopify/Page/5001', 'body')).toContain('market stall');
    expect(storeField(store, 'gid://shopify/Product/1', 'descriptionHtml')).toBeNull();
    expect(storeField(store, 'gid://shopify/Order/7001', 'note')).toBeNull();
  });
});

describe('spanProblem and relocate', () => {
  const link: Span = {
    kind: 'element',
    file: 'sections/x.liquid',
    start: liquid.indexOf('<a '),
    tag: 'a',
    anchor: '<a href="/cart"',
  };

  it('accepts an element span at a start tag with a unique anchor', () => {
    expect(spanProblem(link, theme, null)).toBeNull();
  });

  it('rejects a wrong offset, tag, anchor or file', () => {
    expect(spanProblem({ ...link, start: link.start + 1 }, theme, null)).toMatch(/no element/);
    expect(spanProblem({ ...link, tag: 'button' }, theme, null)).toMatch(/not <button>/);
    expect(spanProblem({ ...link, anchor: '<a class' }, theme, null)).toMatch(/anchor/);
    expect(spanProblem({ ...link, file: 'sections/y.liquid' }, theme, null)).toMatch(
      /does not exist/,
    );
    expect(spanProblem({ ...link, start: 0, tag: 'div', anchor: '<' }, theme, null)).toMatch(
      /more than once/,
    );
  });

  it('checks CSS declarations and JSON values', () => {
    const start = css.indexOf('color');
    const decl: Span = {
      kind: 'css-declaration',
      file: 'assets/base.css',
      selector: '.a',
      start,
      end: start + 'color: #a3a3a3'.length,
      property: 'color',
      anchor: 'color: #a3a3a3',
    };
    expect(spanProblem(decl, theme, null)).toBeNull();
    expect(spanProblem({ ...decl, property: 'outline' }, theme, null)).toMatch(
      /does not set outline/,
    );
    const value = jsonValueAt(json, '/current/color_text');
    const setting: Span = {
      kind: 'json-value',
      file: 'config/settings_data.json',
      pointer: '/current/color_text',
      start: value?.start ?? 0,
      end: value?.end ?? 0,
    };
    expect(spanProblem(setting, theme, null)).toBeNull();
    expect(spanProblem({ ...setting, end: setting.end + 1 }, theme, null)).toMatch(/spans/);
  });

  it('checks data spans against the store', () => {
    const value = storeField(store, 'gid://shopify/Product/7001', 'descriptionHtml') ?? '';
    const start = value.indexOf('<h4>');
    const span: Span = {
      kind: 'data',
      resource: 'gid://shopify/Product/7001',
      field: 'descriptionHtml',
      start,
      end: start + '<h4>Care</h4>'.length,
      anchor: '<h4>Care</h4>',
    };
    expect(spanProblem(span, null, store)).toBeNull();
    expect(spanProblem({ ...span, start: start + 1 }, null, store)).toMatch(/not the anchor/);
    expect(
      spanProblem(
        { kind: 'data', resource: 'gid://shopify/MediaImage/1', field: 'alt' },
        null,
        store,
      ),
    ).toMatch(/no field/);
  });

  it('accepts a zero-length data span for an empty field', () => {
    const empty: Span = {
      kind: 'data',
      resource: 'gid://shopify/MediaImage/9301',
      field: 'alt',
      start: 0,
      end: 0,
      anchor: '',
    };
    expect(spanProblem(empty, null, store)).toBeNull();
    expect(relocate({ ...empty, end: 3 }, null, store)).toEqual(empty);
    expect(
      relocate({ ...empty, resource: 'gid://shopify/MediaImage/9201' }, null, store),
    ).toBeNull();
  });

  it('re-finds an element only where its anchor begins an element with its tag', () => {
    const commented: Theme = {
      name: 'c',
      files: new Map([
        ['sections/c.liquid', '<!-- <a href="/x"> --><div><a href="/x">x</a></div>'],
      ]),
    };
    const span: Span = {
      kind: 'element',
      file: 'sections/c.liquid',
      start: 0,
      tag: 'a',
      anchor: '<a href="/x">x',
    };
    expect(relocate(span, commented, null)).toMatchObject({ start: 27 });
    expect(relocate({ ...span, anchor: '<!-- <a' }, commented, null)).toBeNull();
  });

  it('re-finds spans from their anchors and pointers', () => {
    expect(relocate({ ...link, start: 0 }, theme, null)).toEqual(link);
    const moved = relocate(
      {
        kind: 'json-value',
        file: 'config/settings_data.json',
        pointer: '/current/color_text',
        start: 0,
        end: 0,
      },
      theme,
      null,
    );
    expect(moved).toMatchObject({ start: json.indexOf('"#9b9b9b"') });
    expect(relocate({ ...link, anchor: '<' }, theme, null)).toBeNull();
  });
});
