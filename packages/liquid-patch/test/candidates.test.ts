/**
 * The candidate search of the contrast recipe (ADR-242): the smallest OKLCH lightness change
 * that makes the ratio exceed the threshold, hue and chroma kept.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LIGHTNESS_STEP,
  contrastCandidates,
  smallestChange,
  strongerRatio,
} from '../src/color/candidates.ts';
import {
  contrastRatio,
  fromOklch,
  parseColor,
  toOklch,
  type ParsedColor,
  type Rgb,
} from '../src/color/color.ts';

function color(text: string): ParsedColor {
  const parsed = parseColor(text);
  if (parsed === null) throw new Error(`cannot parse ${text}`);
  return parsed;
}

function bg(text: string): Rgb {
  return color(text).rgb;
}

describe('strongerRatio', () => {
  it('is the enhanced level of WCAG 1.4.6: 4.5 for 3, 7 for 4.5 and above, none beyond 7', () => {
    expect(strongerRatio(3)).toBe(4.5);
    expect(strongerRatio(4.5)).toBe(7);
    expect(strongerRatio(7)).toBeNull();
    expect(strongerRatio(21)).toBeNull();
  });
});

describe('contrastCandidates', () => {
  it('finds the smallest darkening of #9b9b9b on #f4f1ec that exceeds 4.5:1', () => {
    const fg = color('#9b9b9b');
    const background = bg('#f4f1ec');
    expect(contrastRatio(fg.rgb, background)).toBeLessThan(3);
    const [nearest] = contrastCandidates({ foreground: fg, background, minimumRatio: 4.5 });
    expect(nearest?.id).toBe('nearest');
    expect(nearest?.direction).toBe('darker');
    expect(nearest?.ratio).toBeGreaterThan(4.5);
    expect(nearest?.target).toBe(4.5);
    expect(nearest?.color).toMatch(/^#[0-9a-f]{6}$/u);
    // Greys stay grey: the three channels are equal.
    const parsed = parseColor(nearest?.color ?? '');
    expect(parsed?.rgb.r).toBe(parsed?.rgb.g);
    expect(parsed?.rgb.g).toBe(parsed?.rgb.b);
    // One step less change does not reach the threshold: this is the smallest on the grid.
    const original = toOklch(fg.rgb);
    const delta = nearest?.deltaL ?? 0;
    expect(delta).toBeLessThan(0);
    const one = fromOklch({ ...original, l: original.l + delta + LIGHTNESS_STEP });
    expect(contrastRatio(one, background)).toBeLessThanOrEqual(4.5);
  });

  it('offers a second, stronger candidate at the enhanced level, further from the original', () => {
    const candidates = contrastCandidates({
      foreground: color('#9b9b9b'),
      background: bg('#f4f1ec'),
      minimumRatio: 4.5,
    });
    expect(candidates.map((c) => c.id)).toEqual(['nearest', 'stronger']);
    const [nearest, stronger] = candidates;
    expect(stronger?.target).toBe(7);
    expect(stronger?.ratio).toBeGreaterThan(7);
    expect(Math.abs(stronger?.deltaL ?? 0)).toBeGreaterThan(Math.abs(nearest?.deltaL ?? 0));
    expect(stronger?.color).not.toBe(nearest?.color);
  });

  it('needs a smaller change for large text (3:1) than for body text (4.5:1)', () => {
    const fg = color('#9b9b9b');
    const background = bg('#ffffff');
    const large = contrastCandidates({ foreground: fg, background, minimumRatio: 3 })[0];
    const body = contrastCandidates({ foreground: fg, background, minimumRatio: 4.5 })[0];
    expect(Math.abs(large?.deltaL ?? 1)).toBeLessThan(Math.abs(body?.deltaL ?? 0));
    expect(large?.ratio).toBeGreaterThan(3);
  });

  it('keeps hue and chroma of a coloured text', () => {
    const fg = color('#6fa8a0');
    const background = bg('#ffffff');
    const original = toOklch(fg.rgb);
    const [nearest] = contrastCandidates({ foreground: fg, background, minimumRatio: 4.5 });
    expect(nearest).toBeDefined();
    const result = toOklch(parseColor(nearest?.color ?? '')?.rgb ?? { r: 0, g: 0, b: 0 });
    // Hue within one degree and chroma within 0.01 (8-bit rounding), unless the gamut forced less.
    const hueGap = Math.abs(((result.h - original.h + 540) % 360) - 180);
    expect(hueGap).toBeLessThan(2);
    if (nearest?.chromaKept === true) expect(Math.abs(result.c - original.c)).toBeLessThan(0.01);
    expect(result.l).toBeLessThan(original.l);
  });

  it('reports when the chroma had to be reduced to stay inside sRGB', () => {
    // A very saturated light blue on white must darken a long way; dark blues have less
    // chroma room than light ones, so the gamut can force a reduction.
    const candidates = contrastCandidates({
      foreground: color('#00ffff'),
      background: bg('#ffffff'),
      minimumRatio: 4.5,
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.ratio).toBeGreaterThan(candidate.target);
      expect(typeof candidate.chromaKept).toBe('boolean');
    }
  });

  it('picks the direction with the smaller change when both directions reach the threshold', () => {
    // #777777 has relative luminance 0.184: darker and lighter both exceed 3:1 eventually.
    const fg = color('#777777');
    const background = bg('#777777');
    const darker = smallestChange(fg, background, 3, 'darker');
    const lighter = smallestChange(fg, background, 3, 'lighter');
    expect(darker).not.toBeNull();
    expect(lighter).not.toBeNull();
    const [nearest, stronger] = contrastCandidates({ foreground: fg, background, minimumRatio: 3 });
    const expected =
      Math.abs(darker?.deltaL ?? 9) <= Math.abs(lighter?.deltaL ?? 9) ? darker : lighter;
    expect(nearest?.direction).toBe(expected?.direction);
    expect(nearest?.id).toBe('nearest');
    expect(stronger?.id).toBe('stronger');
    expect(stronger?.direction).toBe(nearest?.direction);
  });

  it('returns nothing when the threshold cannot be reached or is already met', () => {
    expect(
      contrastCandidates({
        foreground: color('#777777'),
        background: bg('#777777'),
        minimumRatio: 21,
      }),
    ).toEqual([]);
    expect(
      contrastCandidates({
        foreground: color('#000000'),
        background: bg('#ffffff'),
        minimumRatio: 4.5,
      }),
    ).toEqual([]);
  });

  it('writes the candidate in the format of the original colour and checks the ratio of what it wrote', () => {
    const background = bg('#ffffff');
    for (const text of [
      '#9b9b9b',
      '#9B9B9B',
      'rgb(155, 155, 155)',
      'rgb(155 155 155)',
      'hsl(0, 0%, 60%)',
      'gray',
    ]) {
      const fg = color(text);
      const candidates = contrastCandidates({ foreground: fg, background, minimumRatio: 4.5 });
      expect(candidates.length, text).toBeGreaterThan(0);
      for (const candidate of candidates) {
        const written = parseColor(candidate.color);
        expect(written, candidate.color).not.toBeNull();
        expect(contrastRatio(written?.rgb ?? { r: 0, g: 0, b: 0 }, background)).toBeGreaterThan(
          candidate.target,
        );
        expect(written?.format.kind === 'named' ? 'hex' : written?.format.kind).toBe(
          fg.format.kind === 'named' ? 'hex' : fg.format.kind,
        );
      }
    }
    expect(
      contrastCandidates({ foreground: color('#9B9B9B'), background, minimumRatio: 4.5 })[0]?.color,
    ).toMatch(/^#[0-9A-F]{6}$/u);
  });

  it('is deterministic', () => {
    const request = { foreground: color('#a0a0a0'), background: bg('#ffffff'), minimumRatio: 4.5 };
    expect(contrastCandidates(request)).toEqual(contrastCandidates(request));
  });

  it('always exceeds the threshold, on any colours, in any direction it reports', () => {
    const channel = fc.integer({ min: 0, max: 255 });
    const rgb = fc.record({ r: channel, g: channel, b: channel });
    const threshold = fc.constantFrom(3, 4.5);
    fc.assert(
      fc.property(rgb, rgb, threshold, (fgRgb, bgRgb, minimumRatio) => {
        const fg: ParsedColor = { rgb: fgRgb, alpha: 1, format: { kind: 'hex', upper: false } };
        const candidates = contrastCandidates({ foreground: fg, background: bgRgb, minimumRatio });
        if (contrastRatio(fgRgb, bgRgb) > minimumRatio) {
          expect(candidates).toEqual([]);
          return;
        }
        for (const candidate of candidates) {
          const written = parseColor(candidate.color)?.rgb;
          expect(written).toBeDefined();
          expect(contrastRatio(written ?? fgRgb, bgRgb)).toBeGreaterThan(candidate.target);
          expect(candidate.ratio).toBeGreaterThan(candidate.target);
        }
      }),
      { numRuns: 150 },
    );
  });
});
