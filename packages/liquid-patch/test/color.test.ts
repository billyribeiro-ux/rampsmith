/**
 * The colour maths behind the contrast recipe (ADR-242), against values published by the
 * specifications: WCAG 2.2 relative luminance and contrast ratio, and Björn Ottosson's OKLab
 * as CSS Color Module Level 4 specifies it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clampChroma,
  contrastRatio,
  formatColor,
  fromOklab,
  fromOklch,
  inSrgbGamut,
  isLargeText,
  parseColor,
  relativeLuminance,
  toOklab,
  toOklch,
  type Rgb,
} from '../src/color/color.ts';

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function rgb(text: string): Rgb {
  const parsed = parseColor(text);
  if (parsed === null) throw new Error(`cannot parse ${text}`);
  return parsed.rgb;
}

describe('parseColor', () => {
  it('reads hex colours of 3, 4, 6 and 8 digits and keeps their case', () => {
    expect(parseColor('#fff')).toMatchObject({ rgb: WHITE, alpha: 1, format: { kind: 'hex' } });
    expect(parseColor('#9B9B9B')).toMatchObject({
      rgb: { r: 155, g: 155, b: 155 },
      format: { kind: 'hex', upper: true },
    });
    expect(parseColor('#9b9b9b')).toMatchObject({ format: { kind: 'hex', upper: false } });
    expect(parseColor('#0008')?.alpha).toBeCloseTo(0x88 / 255, 10);
    expect(parseColor('#11223344')).toMatchObject({ rgb: { r: 17, g: 34, b: 51 } });
    expect(parseColor('  #AbC  ')?.rgb).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('reads rgb() and rgba() in the comma and the space syntax', () => {
    expect(parseColor('rgb(155, 155, 155)')).toMatchObject({
      rgb: { r: 155, g: 155, b: 155 },
      format: { kind: 'rgb', comma: true },
    });
    expect(parseColor('rgb(155 155 155 / 50%)')).toMatchObject({
      rgb: { r: 155, g: 155, b: 155 },
      alpha: 0.5,
      format: { kind: 'rgb', comma: false },
    });
    expect(parseColor('rgba(0, 0, 0, 0.25)')?.alpha).toBe(0.25);
    expect(parseColor('rgb(100%, 0%, 50%)')?.rgb).toEqual({ r: 255, g: 0, b: 128 });
    expect(parseColor('rgb(300, -5, 0)')?.rgb).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('reads hsl() and hsla()', () => {
    expect(parseColor('hsl(0, 0%, 100%)')?.rgb).toEqual(WHITE);
    expect(parseColor('hsl(120 100% 25%)')?.rgb).toEqual({ r: 0, g: 128, b: 0 });
    expect(parseColor('hsla(240, 100%, 50%, 0.5)')).toMatchObject({
      rgb: { r: 0, g: 0, b: 255 },
      alpha: 0.5,
      format: { kind: 'hsl' },
    });
    expect(parseColor('hsl(-120deg, 100%, 50%)')?.rgb).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('reads the basic colour names and transparent', () => {
    expect(parseColor('white')?.rgb).toEqual(WHITE);
    expect(parseColor('Gray')?.rgb).toEqual({ r: 128, g: 128, b: 128 });
    expect(parseColor('grey')?.rgb).toEqual({ r: 128, g: 128, b: 128 });
    expect(parseColor('transparent')?.alpha).toBe(0);
  });

  it('rejects what is not one literal colour', () => {
    for (const text of [
      '',
      '#12',
      '#12345',
      '#ggg',
      'rgb(1, 2)',
      'rgb(a, b, c)',
      'var(--x)',
      'currentColor',
      'inherit',
      '{{ settings.color }}',
      'linear-gradient(#fff, #000)',
      '#fff #000',
      'color-mix(in srgb, red, blue)',
    ]) {
      expect(parseColor(text), text).toBeNull();
    }
  });
});

describe('formatColor', () => {
  it('writes hex in the case of the original and rgb() in the original syntax', () => {
    const lower = parseColor('#9b9b9b');
    const upper = parseColor('#9B9B9B');
    const comma = parseColor('rgb(155, 155, 155)');
    const space = parseColor('rgb(155 155 155)');
    const hsl = parseColor('hsl(0, 0%, 60%)');
    if (!lower || !upper || !comma || !space || !hsl) throw new Error('parse');
    const out: Rgb = { r: 118, g: 118, b: 118 };
    expect(formatColor(out, lower.format)).toBe('#767676');
    expect(formatColor(out, upper.format)).toBe('#767676'.toUpperCase());
    expect(formatColor(out, comma.format)).toBe('rgb(118, 118, 118)');
    expect(formatColor(out, space.format)).toBe('rgb(118 118 118)');
    expect(formatColor(out, hsl.format)).toBe('hsl(0, 0%, 46%)');
  });

  it('writes a colour that was a name or a 3-digit hex as 6-digit hex', () => {
    const short = parseColor('#999');
    const named = parseColor('gray');
    if (!short || !named) throw new Error('parse');
    expect(formatColor({ r: 1, g: 2, b: 3 }, short.format)).toBe('#010203');
    expect(formatColor({ r: 1, g: 2, b: 3 }, named.format)).toBe('#010203');
  });
});

describe('WCAG 2.2 contrast', () => {
  it('gives black on white 21:1 and a colour on itself 1:1', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
    expect(contrastRatio(rgb('#9b9b9b'), rgb('#9b9b9b'))).toBe(1);
  });

  it('computes relative luminance with the sRGB transfer function', () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 12);
    expect(relativeLuminance(BLACK)).toBe(0);
    // 0.2126 * 1 for pure red; 0.7152 for green; 0.0722 for blue.
    expect(relativeLuminance(rgb('#ff0000'))).toBeCloseTo(0.2126, 10);
    expect(relativeLuminance(rgb('#00ff00'))).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance(rgb('#0000ff'))).toBeCloseTo(0.0722, 10);
  });

  it('matches the ratios WebAIM publishes for well known greys on white', () => {
    expect(contrastRatio(rgb('#767676'), WHITE)).toBeCloseTo(4.54, 2);
    expect(contrastRatio(rgb('#777777'), WHITE)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(rgb('#595959'), WHITE)).toBeCloseTo(7.0, 1);
    expect(contrastRatio(rgb('#949494'), WHITE)).toBeCloseTo(3.03, 2);
    expect(contrastRatio(rgb('#9b9b9b'), rgb('#f4f1ec'))).toBeLessThan(3);
  });

  it('is symmetric and at least 1', () => {
    const channel = fc.integer({ min: 0, max: 255 });
    const color = fc.record({ r: channel, g: channel, b: channel });
    fc.assert(
      fc.property(color, color, (a, b) => {
        expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
        expect(contrastRatio(a, b)).toBeGreaterThanOrEqual(1);
        expect(contrastRatio(a, b)).toBeLessThanOrEqual(21 + 1e-9);
      }),
    );
  });
});

describe('isLargeText', () => {
  it('follows WCAG: 18pt, or 14pt when bold (24px and 18.66px)', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
    expect(isLargeText(18.67, 700)).toBe(true);
    expect(isLargeText(18, 700)).toBe(false);
    expect(isLargeText(14, 400)).toBe(false);
  });
});

describe('OKLab and OKLCH', () => {
  // CSS Color Module Level 4, "Converting sRGB to OKLab" and the OKLCH examples.
  it('maps white, black and the primaries to the published values', () => {
    const white = toOklab(WHITE);
    expect(white.l).toBeCloseTo(1, 6);
    expect(white.a).toBeCloseTo(0, 6);
    expect(white.b).toBeCloseTo(0, 6);
    expect(toOklab(BLACK)).toEqual({ l: 0, a: 0, b: 0 });
    const red = toOklab(rgb('#ff0000'));
    expect(red.l).toBeCloseTo(0.62796, 4);
    expect(red.a).toBeCloseTo(0.22486, 4);
    expect(red.b).toBeCloseTo(0.12585, 4);
    const green = toOklab(rgb('#00ff00'));
    expect(green.l).toBeCloseTo(0.86644, 4);
    expect(green.a).toBeCloseTo(-0.23389, 4);
    expect(green.b).toBeCloseTo(0.1795, 4);
    const blue = toOklab(rgb('#0000ff'));
    expect(blue.l).toBeCloseTo(0.45201, 4);
    expect(blue.a).toBeCloseTo(-0.03246, 4);
    expect(blue.b).toBeCloseTo(-0.31153, 4);
  });

  it('gives OKLCH chroma and hue for red as CSS Color 4 does: oklch(62.8% 0.2577 29.23)', () => {
    const red = toOklch(rgb('#ff0000'));
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 4);
    expect(red.h).toBeCloseTo(29.23, 1);
  });

  it('puts neutral greys on the lightness axis', () => {
    for (const hex of ['#9b9b9b', '#767676', '#f4f4f4']) {
      expect(toOklch(rgb(hex)).c).toBeLessThan(1e-4);
    }
    // Lightness grows with the grey level.
    expect(toOklab(rgb('#767676')).l).toBeLessThan(toOklab(rgb('#9b9b9b')).l);
  });

  it('round-trips every sRGB colour through OKLab and OKLCH', () => {
    const channel = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(channel, channel, channel, (r, g, b) => {
        const original = { r, g, b };
        expect(fromOklab(toOklab(original))).toEqual(original);
        expect(fromOklch(toOklch(original))).toEqual(original);
      }),
      { numRuns: 500 },
    );
  });

  it('clips a colour outside the sRGB gamut to 8-bit channel values', () => {
    const clipped = fromOklch({ l: 0.5, c: 0.5, h: 30 });
    for (const channel of [clipped.r, clipped.g, clipped.b]) {
      expect(Number.isInteger(channel)).toBe(true);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it('reduces chroma, never hue or lightness, to bring a colour into the gamut', () => {
    const inside = { l: 0.5, c: 0.05, h: 250 };
    expect(clampChroma(inside.l, inside.c, inside.h)).toEqual(inside);
    expect(inSrgbGamut({ l: 0.9, c: 0.4, h: 140 })).toBe(false);
    const clamped = clampChroma(0.9, 0.4, 140);
    expect(clamped.l).toBe(0.9);
    expect(clamped.h).toBe(140);
    expect(clamped.c).toBeGreaterThan(0.1);
    expect(clamped.c).toBeLessThan(0.4);
    expect(inSrgbGamut(clamped)).toBe(true);
    // Just above the largest in-gamut chroma is outside.
    expect(inSrgbGamut({ ...clamped, c: clamped.c + 0.01 })).toBe(false);
  });
});
