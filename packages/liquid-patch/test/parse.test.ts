import { NodeTypes, walk } from '@shopify/liquid-html-parser';
import { describe, expect, it } from 'vitest';
import { countUnparsedLiquid, parseLiquid, parseThemeFile } from '../src/parse.ts';

describe('parseLiquid', () => {
  it('returns a typed AST whose positions are string indexes into the source', () => {
    const source = '<p>\u{1F600}<a href="{{ url }}">x</a></p>';
    const result = parseLiquid(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const anchors: { start: number; end: number }[] = [];
    walk(result.ast, (node) => {
      if (
        node.type === NodeTypes.HtmlElement &&
        source.slice(node.position.start, node.position.start + 2) === '<a'
      ) {
        anchors.push(node.position);
      }
    });
    // The emoji is two UTF-16 code units, so the anchor starts at index 5, not byte 7.
    expect(anchors).toEqual([{ start: 5, end: 30 }]);
    expect(source.slice(5, 30)).toBe('<a href="{{ url }}">x</a>');
  });

  it('returns a typed error with a line and column for unclosed markup', () => {
    const result = parseLiquid('<div>\n  <span>\n</div>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/span|div/u);
    expect(result.error.start).toEqual({ line: 3, column: 1 });
    expect(result.error.message).not.toContain('\n');
  });

  it('returns a typed error for an unterminated Liquid output', () => {
    const result = parseLiquid('{{ product.title');
    expect(result).toMatchObject({ ok: false, error: { start: { line: 1 } } });
  });
});

describe('parseThemeFile', () => {
  it('keeps the path and source beside the AST', () => {
    const result = parseThemeFile('snippets/a.liquid', '<b>x</b>');
    expect(result).toMatchObject({
      ok: true,
      file: { path: 'snippets/a.liquid', source: '<b>x</b>' },
    });
  });

  it('passes the parse error through', () => {
    expect(parseThemeFile('snippets/a.liquid', '<b>')).toMatchObject({ ok: false });
  });
});

describe('countUnparsedLiquid', () => {
  function count(source: string): number {
    const result = parseLiquid(source);
    if (!result.ok) throw new Error(result.error.message);
    return countUnparsedLiquid(result.ast);
  }

  it('is zero for well-formed Liquid, unknown tags, comments and raw tags', () => {
    expect(
      count(
        "{% if a %}{{ 'k' | t }}{% else %}{% render 'x' %}{% endif %}{% comment %}{{{% endcomment %}{% my_tag a b %}{% # note %}",
      ),
    ).toBe(0);
  });

  it('counts output and built-in tags whose markup could not be parsed', () => {
    expect(count('{{ x | | }}')).toBe(1);
    expect(count('{{ }}')).toBe(1);
    expect(count('{% render %}')).toBe(1);
    expect(count('{% if a %}x{% elsif ) %}y{% endif %}')).toBe(1);
  });
});
