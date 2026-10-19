import { describe, expect, it } from 'vitest';
import { hasNonColourDistinction, normalizeColour, parseInlineStyle } from '../src/data/css.ts';

describe('parseInlineStyle', () => {
  it('reads declarations, lower-casing properties and dropping !important', () => {
    const style = parseInlineStyle('COLOR: Red !important; font-weight:bold;;');
    expect([...style]).toEqual([
      ['color', 'Red'],
      ['font-weight', 'bold'],
    ]);
  });

  it('keeps semicolons inside quotes and parentheses, and skips comments', () => {
    const style = parseInlineStyle(
      'background: url("a;b.png") /* c; d */; font-family: "x;y", serif; color: rgb(1, 2, 3)',
    );
    expect(style.get('background')).toBe('url("a;b.png")');
    expect(style.get('font-family')).toBe('"x;y", serif');
    expect(style.get('color')).toBe('rgb(1, 2, 3)');
  });

  it('ignores malformed declarations and an unterminated comment', () => {
    expect([...parseInlineStyle(':x; 9a: 1; color red; /* open')]).toEqual([]);
    expect(parseInlineStyle('color: "unterminated').get('color')).toBe('"unterminated');
  });
});

describe('normalizeColour', () => {
  it('normalises case and spacing and rejects non-colours', () => {
    expect(normalizeColour(' RGB(1, 2, 3) ')).toBe('rgb(1,2,3)');
    for (const v of [undefined, '', 'inherit', 'currentColor', 'transparent', 'unset']) {
      expect(normalizeColour(v)).toBeNull();
    }
  });
});

describe('hasNonColourDistinction', () => {
  const distinct = (css: string): boolean => hasNonColourDistinction(parseInlineStyle(css));

  it('recognises weight, style, decoration, background, border, size, case and caps', () => {
    for (const css of [
      'font-weight: 600',
      'font-weight: bold',
      'font-style: italic',
      'text-decoration: underline dotted',
      'text-decoration-line: line-through',
      'background-color: #ff0',
      'border-bottom: 1px solid',
      'outline: 2px solid',
      'font-size: 1.2em',
      'text-transform: uppercase',
      'font-variant: small-caps',
    ]) {
      expect(distinct(css), css).toBe(true);
    }
  });

  it('rejects colour alone and neutral values', () => {
    for (const css of [
      'color: red',
      'font-weight: 400',
      'font-weight: normal',
      'text-decoration: none',
      'background: none',
      'background-color: transparent',
      'border: none',
      'border: 0',
      'font-size: 100%',
      'text-transform: none',
    ]) {
      expect(distinct(css), css).toBe(false);
    }
  });
});
