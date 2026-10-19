// Locale files of the extension, and a translator with Shopify's `t` semantics: dotted keys,
// `{{ name }}` interpolation, and HTML escaping unless the key ends in `_html`
// (shopify.dev/docs/storefronts/themes/architecture/locales/storefront-locale-files).
import { readFileSync } from 'node:fs';

export interface LocaleTree {
  readonly [key: string]: string | LocaleTree;
}

export type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

function isTree(value: unknown): value is LocaleTree {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string' || isTree(v));
}

/** Reads a locale file, which must be plain JSON: no comments, no trailing commas. */
export function readLocale(file: string): LocaleTree {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isTree(parsed)) throw new Error(`${file}: a locale file holds only nested string values`);
  return parsed;
}

/** Every string in the tree, keyed by its dotted path. */
export function flatten(tree: LocaleTree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

/** Ruby's CGI.escapeHTML, which Liquid's `escape` filter and `t` use. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A translator over `strings` that throws on a missing key instead of printing a notice. */
export function translator(strings: ReadonlyMap<string, string>): Translate {
  return (key, vars = {}) => {
    const template = strings.get(key);
    if (template === undefined) throw new Error(`translation missing: en.${key}`);
    const text = template.replaceAll(/\{\{\s*(\w+)\s*\}\}/gu, (_m, name: string) =>
      String(vars[name] ?? ''),
    );
    return key.endsWith('_html') ? text : escapeHtml(text);
  };
}

/** A pseudo-locale that renders each key as ⟦key⟧, to prove no text bypasses `t`. */
export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';
export function pseudoTranslator(strings: ReadonlyMap<string, string>): Translate {
  return (key) => {
    if (!strings.has(key)) throw new Error(`translation missing: en.${key}`);
    return `${PSEUDO_OPEN}${key}${PSEUDO_CLOSE}`;
  };
}
