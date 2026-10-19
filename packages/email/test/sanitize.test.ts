import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  graphemeLength,
  hasLineBreak,
  multiLine,
  singleLine,
  truncate,
} from '../src/sanitize.ts';

describe('singleLine', () => {
  it('collapses every kind of line break and whitespace into one space', () => {
    expect(singleLine('  Acme\r\n\tShop \u2028 Ltd\u0085 ')).toBe('Acme Shop Ltd');
  });

  it('removes control characters, byte order marks and bidi overrides', () => {
    expect(singleLine('Ac\u0000me\u0007\u009B \uFEFFShop')).toBe('Acme Shop');
    expect(singleLine('evil\u202Egnp.exe')).toBe('evilgnp.exe');
    expect(singleLine('a\u2066b\u2067c\u2068d\u2069e\u202Af\u202Bg\u202Ch\u202Di')).toBe(
      'abcdefghi',
    );
  });

  it('keeps right-to-left text, marks and joiners', () => {
    expect(singleLine('متجر\u200F الأمل')).toBe('متجر\u200F الأمل');
    expect(singleLine('👩\u200D💻 Studio')).toBe('👩\u200D💻 Studio');
  });

  it('repairs lone surrogates and normalises to NFC', () => {
    expect(singleLine('a\uD800b')).toBe('a\uFFFDb');
    expect(singleLine('Cafe\u0301')).toBe('Café');
  });
});

describe('multiLine', () => {
  it('keeps line breaks, trims lines and allows at most one blank line', () => {
    expect(multiLine('  one  two \r\n\r\n\r\n\r\nthree\u2029four  ')).toBe(
      'one two\n\nthree\nfour',
    );
  });

  it('removes control characters except line feeds', () => {
    expect(multiLine('a\u0000b\nc\u001Bd')).toBe('ab\ncd');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('Acme', 4)).toBe('Acme');
  });

  it('cuts to the limit with an ellipsis, counting user-perceived characters', () => {
    expect(truncate('Acme Outfitters', 5)).toBe('Acme…');
    expect(graphemeLength(truncate('👩\u200D💻👩\u200D💻👩\u200D💻👩\u200D💻', 3))).toBe(3);
    expect(truncate('👩\u200D💻👩\u200D💻👩\u200D💻👩\u200D💻', 3)).toBe('👩\u200D💻👩\u200D💻…');
  });

  it('rejects a limit below one', () => {
    expect(() => truncate('x', 0)).toThrow(RangeError);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;',
    );
  });

  it('leaves other text untouched', () => {
    expect(escapeHtml('Café 57% — “quoted”')).toBe('Café 57% — “quoted”');
  });
});

describe('hasLineBreak', () => {
  it.each(['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u0085b'])('finds %j', (value) => {
    expect(hasLineBreak(value)).toBe(true);
  });

  it('passes a single line', () => {
    expect(hasLineBreak('Subject: hello')).toBe(false);
  });
});
