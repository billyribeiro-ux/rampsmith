/**
 * Colour parsing and the maths the contrast recipe needs (ADR-242).
 *
 * - WCAG 2.2 relative luminance and contrast ratio
 *   (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance, #dfn-contrast-ratio), the same
 *   formulas axe-core 4.14.0 uses (`getRelativeLuminance`, `getContrast`).
 * - OKLab and OKLCH after Björn Ottosson, "A perceptual color space for image processing"
 *   (2020), the space CSS Color Module Level 4 specifies for `oklab()` and `oklch()`.
 *
 * Colours are 8-bit sRGB: that is what a browser paints and what axe-core measures, so every
 * ratio computed here is the one a scan will see.
 */

export interface Rgb {
  /** 0 to 255, integers. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklab {
  /** Lightness, 0 (black) to 1 (white). */
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export interface Oklch {
  /** Lightness, 0 to 1. */
  readonly l: number;
  /** Chroma, 0 for greys, about 0.4 at most for sRGB. */
  readonly c: number;
  /** Hue in degrees, 0 to 360. */
  readonly h: number;
}

/** How a colour was written, so a replacement can be written the same way. */
export type ColorFormat =
  | { readonly kind: 'hex'; readonly upper: boolean }
  | { readonly kind: 'rgb'; readonly comma: boolean }
  | { readonly kind: 'hsl'; readonly comma: boolean }
  | { readonly kind: 'named' };

export interface ParsedColor {
  readonly rgb: Rgb;
  /** 0 to 1. */
  readonly alpha: number;
  readonly format: ColorFormat;
}

const NAMED: Readonly<Record<string, string>> = {
  black: '000000',
  silver: 'c0c0c0',
  gray: '808080',
  grey: '808080',
  white: 'ffffff',
  maroon: '800000',
  red: 'ff0000',
  purple: '800080',
  fuchsia: 'ff00ff',
  green: '008000',
  lime: '00ff00',
  olive: '808000',
  yellow: 'ffff00',
  navy: '000080',
  blue: '0000ff',
  teal: '008080',
  aqua: '00ffff',
  orange: 'ffa500',
};

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function byte(text: string): number {
  return Number.parseInt(text, 16);
}

function parseHex(text: string): ParsedColor | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(text);
  const digits = match?.[1];
  if (digits === undefined) return null;
  // Hex digits are ASCII, so code units are the characters here.
  const long = digits.length <= 4 ? digits.replace(/[0-9a-f]/giu, '$&$&') : digits;
  const alpha = long.length === 8 ? byte(long.slice(6, 8)) / 255 : 1;
  return {
    rgb: { r: byte(long.slice(0, 2)), g: byte(long.slice(2, 4)), b: byte(long.slice(4, 6)) },
    alpha,
    format: { kind: 'hex', upper: /[A-F]/u.test(digits) },
  };
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;

/** The arguments of `name(...)` as strings, with the syntax they used; `null` if malformed. */
function functionArguments(
  text: string,
  names: readonly string[],
): { name: string; args: string[]; comma: boolean; alpha: string | null } | null {
  const match = /^([a-z]+)\(\s*([^()]*?)\s*\)$/iu.exec(text);
  const name = match?.[1]?.toLowerCase();
  const inner = match?.[2];
  if (name === undefined || inner === undefined || !names.includes(name)) return null;
  if (inner.includes(',')) {
    const parts = inner.split(',').map((p) => p.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    return { name, args: parts.slice(0, 3), comma: true, alpha: parts[3] ?? null };
  }
  const [colour, alpha, ...rest] = inner.split('/').map((p) => p.trim());
  if (colour === undefined || rest.length > 0) return null;
  const parts = colour.split(/\s+/u);
  if (parts.length !== 3) return null;
  return { name, args: parts, comma: false, alpha: alpha ?? null };
}

function parseAlpha(text: string | null): number | null {
  if (text === null) return 1;
  const match = new RegExp(`^(${NUMBER})(%)?$`, 'iu').exec(text);
  const value = match?.[1];
  if (value === undefined) return null;
  const n = Number(value) / (match?.[2] === undefined ? 1 : 100);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

function parseRgbFunction(text: string): ParsedColor | null {
  const parsed = functionArguments(text, ['rgb', 'rgba']);
  if (parsed === null) return null;
  const channels: number[] = [];
  for (const arg of parsed.args) {
    const match = new RegExp(`^(${NUMBER})(%)?$`, 'iu').exec(arg);
    const value = match?.[1];
    if (value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    channels.push(clampByte(match?.[2] === undefined ? n : (n / 100) * 255));
  }
  const alpha = parseAlpha(parsed.alpha);
  const [r, g, b] = channels;
  if (alpha === null || r === undefined || g === undefined || b === undefined) return null;
  return { rgb: { r, g, b }, alpha, format: { kind: 'rgb', comma: parsed.comma } };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sector: readonly (readonly [number, number, number])[] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r1, g1, b1] = sector[Math.min(5, Math.floor(hue))] ?? [0, 0, 0];
  const m = l - chroma / 2;
  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  };
}

function parseHslFunction(text: string): ParsedColor | null {
  const parsed = functionArguments(text, ['hsl', 'hsla']);
  if (parsed === null) return null;
  const [hue, saturation, lightness] = parsed.args;
  const h = new RegExp(`^(${NUMBER})(deg)?$`, 'iu').exec(hue ?? '')?.[1];
  const s = new RegExp(`^(${NUMBER})%$`, 'iu').exec(saturation ?? '')?.[1];
  const l = new RegExp(`^(${NUMBER})%$`, 'iu').exec(lightness ?? '')?.[1];
  const alpha = parseAlpha(parsed.alpha);
  if (h === undefined || s === undefined || l === undefined || alpha === null) return null;
  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n / 100));
  return {
    rgb: hslToRgb(Number(h), clamp01(Number(s)), clamp01(Number(l))),
    alpha,
    format: { kind: 'hsl', comma: parsed.comma },
  };
}

/**
 * Reads one literal CSS colour: hex (3, 4, 6 or 8 digits), `rgb()`/`rgba()`, `hsl()`/`hsla()`
 * in the comma or the space syntax, a basic colour name, or `transparent`. Anything else
 * (`var()`, `currentColor`, gradients, `color-mix()`, Liquid output) is `null`.
 */
export function parseColor(text: string): ParsedColor | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('#')) return parseHex(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower === 'transparent') {
    return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0, format: { kind: 'named' } };
  }
  const named = NAMED[lower];
  if (named !== undefined) {
    return {
      rgb: { r: byte(named.slice(0, 2)), g: byte(named.slice(2, 4)), b: byte(named.slice(4, 6)) },
      alpha: 1,
      format: { kind: 'named' },
    };
  }
  if (lower.startsWith('rgb')) return parseRgbFunction(trimmed);
  if (lower.startsWith('hsl')) return parseHslFunction(trimmed);
  return null;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function rgbToHsl(color: Rgb): { h: number; s: number; l: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** Writes an opaque colour the way `format` was written; names and short hex become 6-digit hex. */
export function formatColor(color: Rgb, format: ColorFormat): string {
  switch (format.kind) {
    case 'hex':
    case 'named': {
      const text = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
      return format.kind === 'hex' && format.upper ? text.toUpperCase() : text;
    }
    case 'rgb':
      return format.comma
        ? `rgb(${String(color.r)}, ${String(color.g)}, ${String(color.b)})`
        : `rgb(${String(color.r)} ${String(color.g)} ${String(color.b)})`;
    case 'hsl': {
      const { h, s, l } = rgbToHsl(color);
      const parts = [
        String(Math.round(h)),
        `${String(Math.round(s * 100))}%`,
        `${String(Math.round(l * 100))}%`,
      ];
      return format.comma ? `hsl(${parts.join(', ')})` : `hsl(${parts.join(' ')})`;
    }
  }
}

// ---------------------------------------------------------------------------------------
// WCAG
// ---------------------------------------------------------------------------------------

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** WCAG 2.2 relative luminance of an sRGB colour, 0 to 1. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** WCAG 2.2 contrast ratio of two opaque colours, 1 to 21, in either order. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Large text per WCAG 2.2 (SC 1.4.3): at least 18 point, or 14 point when bold. A CSS pixel is
 * 0.75 point; the rounding up matches axe-core 4.14.0's `hasValidContrastRatio`.
 */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  const points = Math.ceil(fontSizePx * 72) / 96;
  return fontWeight >= 700 ? points >= 14 : points >= 18;
}

// ---------------------------------------------------------------------------------------
// OKLab and OKLCH
// ---------------------------------------------------------------------------------------

interface Linear {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function linearToOklab({ r, g, b }: Linear): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear-light sRGB channels, not clamped: outside 0 to 1 means outside the sRGB gamut. */
function oklabToLinear({ l, a, b }: Oklab): Linear {
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    g: -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    b: -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  };
}

export function toOklab(color: Rgb): Oklab {
  return linearToOklab({ r: toLinear(color.r), g: toLinear(color.g), b: toLinear(color.b) });
}

function linearToRgb(linear: Linear): Rgb {
  const channel = (v: number): number => clampByte(fromLinear(Math.min(1, Math.max(0, v))) * 255);
  return { r: channel(linear.r), g: channel(linear.g), b: channel(linear.b) };
}

/** The nearest 8-bit sRGB colour: channels outside the gamut are clipped. */
export function fromOklab(lab: Oklab): Rgb {
  return linearToRgb(oklabToLinear(lab));
}

export function toOklch(color: Rgb): Oklch {
  const { l, a, b } = toOklab(color);
  const c = Math.hypot(a, b);
  const h = c < 1e-7 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const radians = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(radians), b: c * Math.sin(radians) };
}

export function fromOklch(lch: Oklch): Rgb {
  return fromOklab(oklchToOklab(lch));
}

const GAMUT_EPSILON = 1e-4;

/** True when the OKLCH colour is inside the sRGB gamut, up to rounding. */
export function inSrgbGamut(lch: Oklch): boolean {
  const { r, g, b } = oklabToLinear(oklchToOklab(lch));
  return [r, g, b].every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

/**
 * The OKLCH colour at lightness `l` and hue `h` with the largest chroma not above `c` that is
 * inside the sRGB gamut: `c` itself when it fits, otherwise a bisection down towards the grey
 * axis. Hue and lightness are never touched.
 */
export function clampChroma(l: number, c: number, h: number): Oklch {
  if (inSrgbGamut({ l, c, h })) return { l, c, h };
  let low = 0;
  let high = c;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (inSrgbGamut({ l, c: mid, h })) low = mid;
    else high = mid;
  }
  return { l, c: low, h };
}
