import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@rampsmith/ui';

const css = readFileSync(new URL('./site.css', import.meta.url), 'utf8');
const darkBlock = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? '';
const dark = new Map(
  [...darkBlock.matchAll(/--rs-color-([a-z-]+):\s*(#[0-9a-f]{6});/giu)].map(
    ([, name = '', value = '']) => [name, value] as const,
  ),
);
const color = (name: string): string => {
  const value = dark.get(name);
  if (value === undefined) throw new Error(`the dark scheme has no --rs-color-${name}`);
  return value;
};

describe('the dark scheme', () => {
  it('defines every colour token it overrides, and none of the light scheme’s are missing', () => {
    expect([...dark.keys()].sort()).toEqual(
      [
        'accent',
        'accent-hover',
        'border',
        'critical',
        'focus',
        'on-accent',
        'on-critical',
        'success',
        'surface',
        'surface-raised',
        'text',
        'text-muted',
      ].sort(),
    );
  });

  // Text on the two surfaces it sits on, at 4.5:1 (WCAG 1.4.3).
  it.each([
    ['text', 'surface'],
    ['text', 'surface-raised'],
    ['text-muted', 'surface'],
    ['text-muted', 'surface-raised'],
    ['accent', 'surface'],
    ['accent', 'surface-raised'],
    ['accent-hover', 'surface'],
    ['critical', 'surface'],
    ['critical', 'surface-raised'],
    ['success', 'surface'],
    ['on-accent', 'accent'],
    ['on-accent', 'accent-hover'],
    ['on-critical', 'critical'],
  ])('%s on %s reaches 4.5:1', (foreground, background) => {
    expect(contrastRatio(color(foreground), color(background))).toBeGreaterThanOrEqual(4.5);
  });

  // Borders and the focus ring against what they touch, at 3:1 (WCAG 1.4.11).
  it.each([
    ['border', 'surface'],
    ['border', 'surface-raised'],
    ['focus', 'surface'],
    ['focus', 'surface-raised'],
    ['accent', 'surface'],
  ])('%s against %s reaches 3:1', (foreground, background) => {
    expect(contrastRatio(color(foreground), color(background))).toBeGreaterThanOrEqual(3);
  });
});
