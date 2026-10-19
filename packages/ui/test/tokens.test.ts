import { commands } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import css from '../src/tokens.css?raw';
import { contrastRatio, relativeLuminance } from '../src/contrast.ts';

function token(name: string): string {
  const match = new RegExp(`--rs-color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (match?.[1] === undefined) throw new Error(`no colour token ${name}`);
  return match[1];
}

describe('contrast', () => {
  it('computes WCAG relative luminance and contrast ratios', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(() => contrastRatio('red', '#fff')).toThrow();
  });
});

describe('colour tokens', () => {
  it('give text at least 4.5:1 on every surface it sits on', () => {
    const pairs: [string, string][] = [
      ['text', 'surface'],
      ['text', 'surface-raised'],
      ['text-muted', 'surface'],
      ['text-muted', 'surface-raised'],
      ['accent', 'surface'],
      ['accent', 'surface-raised'],
      ['on-accent', 'accent'],
      ['on-accent', 'accent-hover'],
      ['critical', 'surface'],
      ['critical', 'surface-raised'],
      ['on-critical', 'critical'],
      ['success', 'surface'],
      ['success', 'surface-raised'],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrastRatio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('give UI boundaries and the focus ring at least 3:1', () => {
    const pairs: [string, string][] = [
      ['border', 'surface'],
      ['border', 'surface-raised'],
      ['focus', 'surface'],
      ['focus', 'surface-raised'],
      ['accent', 'surface'],
      ['critical', 'surface'],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrastRatio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('motion', () => {
  afterEach(async () => {
    await commands.reducedMotion(false);
  });

  it('drops transition durations to zero when the user asks for reduced motion', async () => {
    const root = document.documentElement;
    expect(getComputedStyle(root).getPropertyValue('--rs-duration').trim()).toBe('150ms');
    await commands.reducedMotion(true);
    expect(getComputedStyle(root).getPropertyValue('--rs-duration').trim()).toBe('0ms');
  });
});
