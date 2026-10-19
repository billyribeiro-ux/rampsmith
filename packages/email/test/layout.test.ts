import { describe, expect, it } from 'vitest';
import { PALETTES } from '../src/render-html.ts';
import { TEXT_WIDTH, wrap } from '../src/render-text.ts';

/** WCAG 2.2 relative luminance of an sRGB colour such as `#1d4ed8`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('colour contrast of both palettes (WCAG 1.4.3, 1.4.11)', () => {
  it.each(['light', 'dark'] as const)('%s: text pairs reach 4.5:1', (scheme) => {
    const p = PALETTES[scheme];
    const pairs: [string, string, string][] = [
      ['text on card', p.text, p.card],
      ['text on page', p.text, p.page],
      ['text on subtle', p.text, p.subtle],
      ['muted on card', p.muted, p.card],
      ['muted on page', p.muted, p.page],
      ['link on card', p.link, p.card],
      ['link on page', p.link, p.page],
      ['link on subtle', p.link, p.subtle],
      ['button text', p.buttonText, p.buttonBackground],
    ];
    for (const [name, fg, bg] of pairs) {
      expect(contrast(fg, bg), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)(
    '%s: the button stands out from the card at 3:1',
    (scheme) => {
      const p = PALETTES[scheme];
      expect(contrast(p.buttonBackground, p.card)).toBeGreaterThanOrEqual(3);
    },
  );

  it('computes the known ratio for black on white', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('wrap', () => {
  it('wraps on spaces at the width', () => {
    const text = 'one two three four five six seven eight nine ten';
    expect(wrap(text, 14)).toBe('one two three\nfour five six\nseven eight\nnine ten');
  });

  it('never breaks a long word such as a link', () => {
    const link = `https://app.rampsmith.example/${'a'.repeat(100)}`;
    expect(wrap(`Open ${link} now`, TEXT_WIDTH)).toBe(`Open\n${link}\nnow`);
  });

  it('indents continuation lines', () => {
    expect(wrap('alpha beta gamma', 11, '  ', '- ')).toBe('- alpha\n  beta\n  gamma');
  });

  it('counts user-perceived characters', () => {
    expect(wrap('👩\u200D💻👩\u200D💻 ab', 5)).toBe('👩\u200D💻👩\u200D💻 ab');
  });
});
