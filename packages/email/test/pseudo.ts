/**
 * Pseudo-locales built from the English catalog, to prove a new language needs only a catalog:
 * `en-XA` lengthens every message by about 40% with accented letters (text expansion), and
 * `ar-XB` uses the same text under a right-to-left language tag.
 */
import { SHIPPED_CATALOGS, type CatalogSources } from '../src/index.ts';

const ACCENTS: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  A: 'Å',
  E: 'É',
  I: 'Î',
  O: 'Ö',
  U: 'Û',
  c: 'ç',
  n: 'ñ',
  s: 'š',
  y: 'ý',
};

/** Accents and pads the literal text of a pattern, leaving placeholders and escapes alone. */
function pseudoPattern(pattern: string): string {
  let out = '';
  let literal = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern.charAt(i);
    if (c === '\\') {
      out += pattern.slice(i, i + 2);
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      out += pattern.slice(i, end + 1);
      i = end;
    } else {
      out += ACCENTS[c] ?? c;
      literal += 1;
    }
  }
  return `[${out}${' ~'.repeat(Math.ceil((literal * 0.4) / 2))}]`;
}

interface Variants {
  readonly declarations?: readonly string[];
  readonly selectors?: readonly string[];
  readonly match: Readonly<Record<string, string>>;
}

function pseudoMessage(message: unknown): unknown {
  if (typeof message === 'string') {
    return pseudoPattern(message);
  }
  return (message as readonly Variants[]).map((variant) => ({
    ...variant,
    match: Object.fromEntries(
      Object.entries(variant.match).map(([key, pattern]) => [key, pseudoPattern(pattern)]),
    ),
  }));
}

function pseudoCatalog(): Record<string, unknown> {
  const base = SHIPPED_CATALOGS['en'] ?? {};
  return Object.fromEntries(
    Object.entries(base)
      .filter(([key]) => key !== '$schema')
      .map(([key, message]) => [key, pseudoMessage(message)]),
  );
}

/** The shipped catalogs plus `en-XA` and `ar-XB`. */
export function pseudoCatalogs(): CatalogSources {
  const pseudo = pseudoCatalog();
  return { ...SHIPPED_CATALOGS, 'en-XA': pseudo, 'ar-XB': pseudo };
}
