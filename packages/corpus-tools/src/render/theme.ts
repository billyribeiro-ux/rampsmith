// Loading a theme directory into memory (Shopify theme architecture, ADR-201).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

/**
 * The directories Shopify reads; "Subdirectories, other than the ones listed, aren't
 * supported" (shopify.dev/docs/storefronts/themes/architecture, read 2026-10-17).
 */
export const THEME_DIRECTORIES = [
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
  'templates/customers',
] as const;

const TEXT_EXTENSIONS = ['.liquid', '.json', '.css', '.js', '.svg'];

export interface Theme {
  readonly name: string;
  /** Theme-relative path with forward slashes → contents, text files only. */
  readonly files: ReadonlyMap<string, string>;
}

function walk(dir: string, root: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, root, out);
      continue;
    }
    const path = relative(root, full).split(sep).join('/');
    if (TEXT_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      out.set(path, readFileSync(full, 'utf8'));
    }
  }
}

/** Reads every text file of a theme. Fails on a file outside Shopify's directories. */
export function loadTheme(name: string, dir: string): Theme {
  const files = new Map<string, string>();
  walk(dir, dir, files);
  for (const path of files.keys()) {
    const folder = path.slice(0, path.lastIndexOf('/'));
    if (!(THEME_DIRECTORIES as readonly string[]).includes(folder)) {
      throw new Error(`${name}: ${path} is outside Shopify's theme directories`);
    }
  }
  if (!files.has('layout/theme.liquid'))
    throw new Error(`${name}: layout/theme.liquid is required`);
  return { name, files };
}

/** Reads a theme file or fails naming it. */
export function themeFile(theme: Theme, path: string): string {
  const contents = theme.files.get(path);
  if (contents === undefined) throw new Error(`${theme.name}: ${path} does not exist`);
  return contents;
}

/** Parses a theme JSON file; theme JSON may carry comments (shopify.dev, architecture). */
export function themeJson(theme: Theme, path: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(themeFile(theme, path), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) throw new Error(`${theme.name}: ${path} is not valid JSON`);
  return value;
}

/** The JSON inside a Liquid file's `{% schema %}` tag, or `null` when it has none. */
export function sectionSchema(source: string): Record<string, unknown> | null {
  const match = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(source);
  if (match?.[1] === undefined) return null;
  const value: unknown = JSON.parse(match[1]);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the schema tag must hold a JSON object');
  }
  return value as Record<string, unknown>;
}
