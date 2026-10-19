/**
 * The contrast fix of PLAN §12 (ADR-242): the smallest change of OKLCH lightness that makes a
 * text colour exceed the required contrast ratio on its background, hue and chroma kept, with
 * a second, stronger candidate for the merchant to choose.
 *
 * The search is a walk, not a closed form, so that the answer is a colour a browser can paint:
 * lightness moves in steps of {@link LIGHTNESS_STEP}; at each step the chroma is clamped into
 * the sRGB gamut without touching hue, the colour is rounded to 8-bit channels and written in
 * the format of the original, and the ratio is measured on what was written. The first step
 * whose ratio exceeds the threshold is the answer. The comparison is strict (`>`) because
 * axe-core 4.14.0 reports a failure unless `contrast > expected`.
 */
import {
  clampChroma,
  contrastRatio,
  formatColor,
  fromOklch,
  parseColor,
  toOklch,
  type ParsedColor,
  type Rgb,
} from './color.ts';

/** OKLCH lightness moves in steps of 0.001, about a quarter of a level of 8-bit grey. */
export const LIGHTNESS_STEP = 0.001;

export type CandidateId = 'nearest' | 'stronger';

export interface ColorCandidate {
  readonly id: CandidateId;
  /** The colour as it is written into the theme, in the format of the original. */
  readonly color: string;
  readonly rgb: Rgb;
  /** The measured ratio of the written colour on the background. */
  readonly ratio: number;
  /** The ratio this candidate was searched for; `ratio` exceeds it. */
  readonly target: number;
  readonly direction: 'darker' | 'lighter';
  /** Signed change of OKLCH lightness from the original. */
  readonly deltaL: number;
  /** False when the gamut forced a lower chroma than the original's. */
  readonly chromaKept: boolean;
}

export interface CandidateRequest {
  readonly foreground: ParsedColor;
  /** The opaque colour behind the text, as the scanner measured it. */
  readonly background: Rgb;
  /** The ratio to exceed: 4.5 for body text, 3 for large text. */
  readonly minimumRatio: number;
}

/** The enhanced level of WCAG 1.4.6 above `ratio`: 4.5 above 3, 7 above 4.5, none above 7. */
export function strongerRatio(ratio: number): number | null {
  if (ratio < 4.5) return 4.5;
  return ratio < 7 ? 7 : null;
}

/**
 * The first lightness step in `direction` whose written colour exceeds `target` on
 * `background`, or `null` when lightness runs out first.
 */
export function smallestChange(
  foreground: ParsedColor,
  background: Rgb,
  target: number,
  direction: 'darker' | 'lighter',
): Omit<ColorCandidate, 'id'> | null {
  const original = toOklch(foreground.rgb);
  const sign = direction === 'darker' ? -1 : 1;
  for (let step = 1; step <= Math.ceil(1 / LIGHTNESS_STEP); step += 1) {
    const l = original.l + sign * step * LIGHTNESS_STEP;
    if (l < 0 || l > 1) return null;
    const clamped = clampChroma(l, original.c, original.h);
    const text = formatColor(fromOklch(clamped), foreground.format);
    // Measure what is written: a format such as hsl() rounds again.
    const written = parseColor(text)?.rgb;
    if (written === undefined) return null;
    const ratio = contrastRatio(written, background);
    if (ratio > target) {
      return {
        color: text,
        rgb: written,
        ratio,
        target,
        direction,
        deltaL: l - original.l,
        chromaKept: clamped.c >= original.c - 1e-9,
      };
    }
  }
  return null;
}

/**
 * Up to two candidates, best first, or none when the colour already exceeds the threshold or
 * no lightness reaches it:
 *
 * 1. `nearest`: the smaller of the darker and the lighter change that exceeds the threshold.
 * 2. `stronger`: the smallest change in the same direction that exceeds the enhanced level
 *    (WCAG 1.4.6: 4.5:1 for large text, 7:1 for body text), when that is reachable and
 *    differs from the first.
 */
export function contrastCandidates(request: CandidateRequest): ColorCandidate[] {
  const { foreground, background, minimumRatio } = request;
  if (contrastRatio(foreground.rgb, background) > minimumRatio) return [];
  const darker = smallestChange(foreground, background, minimumRatio, 'darker');
  const lighter = smallestChange(foreground, background, minimumRatio, 'lighter');
  let first: Omit<ColorCandidate, 'id'> | null;
  if (darker === null) first = lighter;
  else if (lighter === null) first = darker;
  else first = Math.abs(lighter.deltaL) < Math.abs(darker.deltaL) ? lighter : darker;
  if (first === null) return [];
  const candidates: ColorCandidate[] = [{ id: 'nearest', ...first }];
  const enhanced = strongerRatio(minimumRatio);
  if (enhanced !== null) {
    const second = smallestChange(foreground, background, enhanced, first.direction);
    if (second !== null && second.color !== first.color) {
      candidates.push({ id: 'stronger', ...second });
    }
  }
  return candidates;
}
