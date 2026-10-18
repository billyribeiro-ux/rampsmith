import { describe, expect, it } from 'vitest';
import type { Span } from '../src/golden.ts';
import { loadStore } from '../src/render/store.ts';
import type { Theme } from '../src/render/theme.ts';
import {
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
    expect(pointerPath('/current/a~1b/1')).toEqual(['current', 'a/b', 1]);
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
