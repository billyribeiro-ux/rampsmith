/**
 * Theme translation keys for recipe labels, and the locale-file edits that add them (ADR-103).
 *
 * Shopify's storefront locale files are `locales/<IETF tag>.json`, exactly one of them named
 * `<tag>.default.json`; `locales/*.schema.json` files translate theme editor settings and are
 * never touched here. Translations are HTML-escaped unless the key ends in `_html`, so recipe
 * keys never do (https://shopify.dev/docs/storefronts/themes/architecture/locales/storefront-locale-files).
 */
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import type { Edit } from './edits.ts';

export interface TranslationRequirement {
  /** Dotted key such as `accessibility.skip_to_text`. */
  readonly key: string;
  /** The English text. */
  readonly text: string;
}

export interface LocaleText extends TranslationRequirement {
  /** Text for other languages by IETF tag (`de`, `pt-BR`); a base language also covers its regions. */
  readonly byLocale?: Readonly<Record<string, string>>;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Why a key cannot be used, or `null` when it can. */
export function translationKeyProblem(key: string): string | null {
  if (!KEY_PATTERN.test(key)) {
    return `"${key}" must be two or more dot-separated segments of a-z, 0-9 and _`;
  }
  if (key.endsWith('_html')) return `"${key}" ends in _html, which would turn off HTML escaping`;
  return null;
}

/** Why a text cannot be used, or `null` when it can. */
export function translationTextProblem(text: string): string | null {
  if (text.trim() === '') return 'the text is empty';
  if (text.includes('{{') || text.includes('}}')) return 'the text contains {{ or }}';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'the text contains a control character';
  }
  return null;
}

/** Liquid that prints a translation: `{{ 'key' | t }}`. Keys never contain quotes. */
export function translationOutput(key: string): string {
  return `{{ '${key}' | t }}`;
}

export interface LocaleFile {
  /** Theme-relative path such as `locales/en.default.json`. */
  readonly path: string;
  readonly source: string;
}

export type LocaleErrorCode =
  | 'not-a-locale-file'
  | 'no-default-locale'
  | 'several-default-locales'
  | 'invalid-json'
  | 'invalid-key'
  | 'invalid-text'
  | 'key-conflict';

export interface LocaleError {
  readonly code: LocaleErrorCode;
  readonly file: string | null;
  readonly message: string;
}

export interface Untranslated {
  readonly file: string;
  readonly key: string;
}

export type LocaleEditsResult =
  | {
      readonly ok: true;
      readonly edits: readonly Edit[];
      /** Keys written with the English text into a file of another language. */
      readonly untranslated: readonly Untranslated[];
    }
  | { readonly ok: false; readonly error: LocaleError };

const STOREFRONT_LOCALE = /^locales\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(\.default)?\.json$/u;
const SCHEMA_LOCALE = /^locales\/[^/]+\.schema\.json$/u;

interface StorefrontLocale {
  readonly file: LocaleFile;
  readonly tag: string;
  readonly isDefault: boolean;
}

function localeError(
  code: LocaleErrorCode,
  file: string | null,
  message: string,
): LocaleEditsResult {
  return { ok: false, error: { code, file, message } };
}

/** A tree of the properties missing under one existing object: a string is a leaf text. */
type Missing = Map<string, Missing | string>;

function property(object: JsonNode, name: string): JsonNode | undefined {
  return object.children?.find((p) => p.children?.[0]?.value === name);
}

function textFor(entry: LocaleText, tag: string): { text: string; translated: boolean } {
  const base = tag.split('-')[0] ?? tag;
  const exact = entry.byLocale?.[tag] ?? entry.byLocale?.[base];
  if (exact !== undefined) return { text: exact, translated: true };
  return { text: entry.text, translated: base.toLowerCase() === 'en' };
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/** One indentation level, from the first indented property line; two spaces by default. */
function indentUnit(source: string): string {
  const match = /\n([ \t]+)"/u.exec(source);
  return match?.[1] ?? '  ';
}

interface Layout {
  readonly eol: string;
  readonly unit: string;
  readonly colon: string;
}

function renderValue(
  value: Missing | string,
  indent: string,
  layout: Layout,
  multiline: boolean,
): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const inner = indent + layout.unit;
  const entries = [...value].map(
    ([name, child]) =>
      `${JSON.stringify(name)}${layout.colon}${renderValue(child, inner, layout, multiline)}`,
  );
  return multiline
    ? `{${layout.eol}${inner}${entries.join(`,${layout.eol}${inner}`)}${layout.eol}${indent}}`
    : `{ ${entries.join(', ')} }`;
}

function insertionFor(
  source: string,
  path: string,
  object: JsonNode,
  missing: Missing,
  layout: Layout,
): Edit {
  const open = object.offset;
  const close = object.offset + object.length - 1;
  const last = object.children?.at(-1);
  // An empty file object (`{}`) is expanded; any other object keeps its own layout.
  const multiline =
    source.slice(open, close).includes('\n') || (object.parent === undefined && last === undefined);
  if (last === undefined) {
    const ownIndent = /^[ \t]*/u.exec(source.slice(lineStart(source, open), open))?.[0] ?? '';
    const inner = ownIndent + layout.unit;
    const entries = [...missing].map(
      ([name, child]) =>
        `${JSON.stringify(name)}${layout.colon}${renderValue(child, inner, layout, multiline)}`,
    );
    const replacement = multiline
      ? `${layout.eol}${inner}${entries.join(`,${layout.eol}${inner}`)}${layout.eol}${ownIndent}`
      : ` ${entries.join(', ')} `;
    return { file: path, start: open + 1, end: close, replacement };
  }
  const keyStart = last.offset;
  const indent = /^[ \t]*/u.exec(source.slice(lineStart(source, keyStart), keyStart))?.[0] ?? '';
  const separator = multiline ? `,${layout.eol}${indent}` : ', ';
  const entries = [...missing].map(
    ([name, child]) =>
      `${JSON.stringify(name)}${layout.colon}${renderValue(child, indent, layout, multiline)}`,
  );
  const at = last.offset + last.length;
  return { file: path, start: at, end: at, replacement: `${separator}${entries.join(separator)}` };
}

function merge(tree: Missing, segments: readonly string[], text: string): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  const existing = tree.get(head);
  if (rest.length === 0) {
    if (existing === undefined) {
      tree.set(head, text);
      return true;
    }
    return existing === text;
  }
  if (typeof existing === 'string') return false;
  const child = existing ?? new Map<string, Missing | string>();
  tree.set(head, child);
  return merge(child, rest, text);
}

/**
 * Edits that add every key to every storefront locale file, as insertions after the last
 * property of the deepest object that already exists, indented like that file. A key that
 * already exists is left alone, so the edits are idempotent. The default locale and every
 * other locale receive `byLocale[tag]`, else `byLocale[base language]`, else the English
 * `text`; files of another language that get the English text are listed in `untranslated`.
 */
export function localeEdits(
  files: readonly LocaleFile[],
  entries: readonly LocaleText[],
): LocaleEditsResult {
  for (const entry of entries) {
    const keyProblem = translationKeyProblem(entry.key);
    if (keyProblem !== null) return localeError('invalid-key', null, keyProblem);
    for (const text of [entry.text, ...Object.values(entry.byLocale ?? {})]) {
      const textProblem = translationTextProblem(text);
      if (textProblem !== null)
        return localeError('invalid-text', null, `${entry.key}: ${textProblem}`);
    }
  }
  const locales: StorefrontLocale[] = [];
  for (const file of files) {
    if (SCHEMA_LOCALE.test(file.path)) continue;
    const match = STOREFRONT_LOCALE.exec(file.path);
    if (match === null) {
      return localeError(
        'not-a-locale-file',
        file.path,
        `${file.path} is not a storefront locale file`,
      );
    }
    locales.push({ file, tag: match[1] ?? '', isDefault: match[2] !== undefined });
  }
  const defaults = locales.filter((l) => l.isDefault).length;
  if (defaults === 0)
    return localeError('no-default-locale', null, 'no locales/*.default.json was given');
  if (defaults > 1)
    return localeError('several-default-locales', null, 'only one default locale file is allowed');

  const edits: Edit[] = [];
  const untranslated: Untranslated[] = [];
  for (const { file, tag } of locales) {
    const errors: ParseError[] = [];
    const root = parseTree(file.source, errors, {
      allowTrailingComma: false,
      disallowComments: false,
    });
    if (root?.type !== 'object' || errors.length > 0) {
      return localeError('invalid-json', file.path, `${file.path} is not a JSON object`);
    }
    const layout: Layout = {
      eol: file.source.includes('\r\n') ? '\r\n' : '\n',
      unit: indentUnit(file.source),
      colon: /"\s*:\s/u.test(file.source) || !file.source.includes('":') ? ': ' : ':',
    };
    const byAnchor = new Map<JsonNode, Missing>();
    for (const entry of entries) {
      const segments = entry.key.split('.');
      let object = root;
      let depth = 0;
      let exists = false;
      for (; depth < segments.length; depth += 1) {
        const found = property(object, segments[depth] ?? '');
        if (found === undefined) break;
        const value = found.children?.[1];
        if (depth === segments.length - 1) {
          exists = true;
          break;
        }
        if (value?.type !== 'object') {
          return localeError(
            'key-conflict',
            file.path,
            `${entry.key}: ${segments.slice(0, depth + 1).join('.')} is not an object`,
          );
        }
        object = value;
      }
      if (exists) continue;
      const { text, translated } = textFor(entry, tag);
      const tree = byAnchor.get(object) ?? new Map<string, Missing | string>();
      byAnchor.set(object, tree);
      if (!merge(tree, segments.slice(depth), text)) {
        return localeError(
          'key-conflict',
          file.path,
          `${entry.key} conflicts with another requested key`,
        );
      }
      if (!translated && !untranslated.some((u) => u.file === file.path && u.key === entry.key)) {
        untranslated.push({ file: file.path, key: entry.key });
      }
    }
    for (const [object, missing] of byAnchor) {
      edits.push(insertionFor(file.source, file.path, object, missing, layout));
    }
  }
  return { ok: true, edits, untranslated };
}
