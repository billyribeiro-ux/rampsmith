// A small, linear-time reader for inline `style` attributes. It understands what the
// colour-only rule needs (declarations, `!important`, comments, quotes, parentheses) and
// nothing more; it never evaluates anything.

/** Declarations of an inline style, keyed by lower-cased property; the last one wins. */
export function parseInlineStyle(style: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  let current = '';
  let quote: string | null = null;
  let parens = 0;
  let i = 0;
  while (i < style.length) {
    const ch = style.charAt(i);
    if (quote !== null) {
      current += ch;
      if (ch === '\\' && i + 1 < style.length) {
        current += style.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && style.charAt(i + 1) === '*') {
      const close = style.indexOf('*/', i + 2);
      i = close === -1 ? style.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parens += 1;
    else if (ch === ')' && parens > 0) parens -= 1;
    else if (ch === ';' && parens === 0) {
      addDeclaration(declarations, current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  addDeclaration(declarations, current);
  return declarations;
}

function addDeclaration(into: Map<string, string>, text: string): void {
  const colon = text.indexOf(':');
  if (colon <= 0) return;
  const property = text.slice(0, colon).trim().toLowerCase();
  if (!/^-?[a-z][a-z0-9-]*$/.test(property)) return;
  const value = text
    .slice(colon + 1)
    .replace(/!\s*important\s*$/i, '')
    .trim();
  if (value === '') return;
  into.set(property, value);
}

const NOT_A_COLOUR = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'currentcolor',
  'transparent',
]);

/** A declared text colour, normalised for comparison, or `null` when it sets no real colour. */
export function normalizeColour(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  if (v === '' || NOT_A_COLOUR.has(v)) return null;
  return v;
}

const NONE_VALUES = new Set(['none', 'normal', 'initial', 'inherit', 'unset', 'revert', '0']);

/**
 * Whether the declarations set the text apart by something other than colour: weight, style,
 * decoration, background, border, outline, size, case or small capitals (ADR-113).
 */
export function hasNonColourDistinction(style: ReadonlyMap<string, string>): boolean {
  const weight = style.get('font-weight')?.toLowerCase();
  if (weight !== undefined && /^(?:bold|bolder|[6-9]00|1000)$/.test(weight)) return true;
  const fontStyle = style.get('font-style')?.toLowerCase();
  if (fontStyle !== undefined && /^(?:italic|oblique)/.test(fontStyle)) return true;
  for (const property of ['text-decoration', 'text-decoration-line']) {
    const value = style.get(property)?.toLowerCase();
    if (value !== undefined && /\b(?:underline|overline|line-through)\b/.test(value)) return true;
  }
  for (const property of ['background', 'background-color', 'background-image']) {
    const value = style.get(property)?.toLowerCase().trim();
    if (value !== undefined && !NONE_VALUES.has(value) && value !== 'transparent') return true;
  }
  for (const [property, raw] of style) {
    if (
      !/^(?:border|outline)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-style)?$/.test(
        property,
      )
    ) {
      continue;
    }
    const value = raw.toLowerCase();
    if (!/\b(?:none|hidden)\b/.test(value) && !/^0(?:px)?$/.test(value.trim())) return true;
  }
  const size = style.get('font-size')?.toLowerCase().trim();
  if (size !== undefined && !NONE_VALUES.has(size) && !/^(?:100%|1em|1rem|medium)$/.test(size)) {
    return true;
  }
  const transform = style.get('text-transform')?.toLowerCase();
  if (transform !== undefined && /^(?:uppercase|capitalize)$/.test(transform)) return true;
  const variant =
    style.get('font-variant')?.toLowerCase() ?? style.get('font-variant-caps')?.toLowerCase();
  if (variant !== undefined && /small-caps|all-small-caps|petite-caps/.test(variant)) return true;
  return false;
}
