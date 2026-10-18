/**
 * Message catalogs and formatting (ADR-192).
 *
 * Copy lives in inlang message-format JSON (`messages/{locale}.json`), the format and plugin
 * `apps/web` uses with Paraglide JS, so the same tooling and translators work on both. This
 * module formats the subset of that format the emails use: `{name}` placeholders, `\{`, `\}`
 * and `\\` escapes, and variant messages whose selectors are inputs, exact-value aliases
 * (`local x = n`) or plural categories (`local x = n: plural`), with `*` as a wildcard.
 * Markup placeholders and other functions are rejected when a catalog is loaded, so a catalog
 * that would format differently in Paraglide fails fast.
 */

export class CatalogError extends Error {
  constructor(locale: string, key: string, reason: string) {
    super(`messages/${locale}.json "${key}": ${reason}`);
    this.name = 'CatalogError';
  }
}

type Part = { readonly text: string } | { readonly variable: string };

interface Variant {
  readonly conditions: ReadonlyMap<string, string>;
  readonly parts: readonly Part[];
}

type Local =
  | { readonly kind: 'alias'; readonly input: string }
  | { readonly kind: 'plural'; readonly input: string };

interface ComplexMessage {
  readonly inputs: ReadonlySet<string>;
  readonly locals: ReadonlyMap<string, Local>;
  readonly selectors: readonly string[];
  readonly variants: readonly Variant[];
}

type CompiledMessage = { readonly parts: readonly Part[] } | ComplexMessage;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Splits a pattern into literal text and `{variable}` placeholders. */
function parsePattern(pattern: string, fail: (reason: string) => never): Part[] {
  const parts: Part[] = [];
  let text = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern.charAt(i);
    if (c === '\\') {
      const next = pattern.charAt(i + 1);
      if (next !== '{' && next !== '}' && next !== '\\') {
        fail('a backslash may only escape {, } or \\');
      }
      text += next;
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        fail('unclosed {');
      }
      const name = pattern.slice(i + 1, end).trim();
      if (!NAME.test(name)) {
        fail(`unsupported placeholder {${name}}: only {name} is allowed`);
      }
      if (text.length > 0) {
        parts.push({ text });
        text = '';
      }
      parts.push({ variable: name });
      i = end;
    } else if (c === '}') {
      fail('unmatched }');
    } else {
      text += c;
    }
  }
  if (text.length > 0) {
    parts.push({ text });
  }
  return parts;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function compileComplex(raw: readonly unknown[], fail: (reason: string) => never): ComplexMessage {
  const [entry, ...rest] = raw;
  if (rest.length > 0 || !isRecord(entry)) {
    fail('a variant message must be an array holding one object');
  }
  const declarations = entry['declarations'] ?? [];
  const selectors = entry['selectors'] ?? [];
  const match = entry['match'];
  if (!isList(declarations) || !isList(selectors) || !isRecord(match)) {
    fail('a variant message needs "declarations" and "selectors" arrays and a "match" object');
  }
  const inputs = new Set<string>();
  const locals = new Map<string, Local>();
  for (const declaration of declarations) {
    if (typeof declaration !== 'string') {
      fail('every declaration must be a string');
    }
    const input = /^input ([A-Za-z_][A-Za-z0-9_]*)$/u.exec(declaration);
    const local =
      /^local ([A-Za-z_][A-Za-z0-9_]*) = ([A-Za-z_][A-Za-z0-9_]*)(?:: (plural))?$/u.exec(
        declaration,
      );
    if (input?.[1] !== undefined) {
      inputs.add(input[1]);
    } else if (local?.[1] !== undefined && local[2] !== undefined) {
      if (!inputs.has(local[2])) {
        fail(`local ${local[1]} reads ${local[2]}, which is not declared as an input first`);
      }
      locals.set(local[1], {
        kind: local[3] === 'plural' ? 'plural' : 'alias',
        input: local[2],
      });
    } else {
      fail(`unsupported declaration "${declaration}"`);
    }
  }
  const selectorNames: string[] = [];
  for (const selector of selectors) {
    if (typeof selector !== 'string' || (!inputs.has(selector) && !locals.has(selector))) {
      fail('every selector must name a declared input or local');
    }
    selectorNames.push(selector);
  }
  const variants: Variant[] = [];
  for (const [key, pattern] of Object.entries(match)) {
    if (typeof pattern !== 'string') {
      fail(`variant "${key}" must be a string`);
    }
    const conditions = new Map<string, string>();
    for (const condition of key.split(',')) {
      const [selector, value, ...extra] = condition.trim().split('=');
      if (
        selector === undefined ||
        value === undefined ||
        extra.length > 0 ||
        !selectorNames.includes(selector) ||
        value.length === 0
      ) {
        fail(`variant key "${key}" must be selector=value pairs over the declared selectors`);
      }
      conditions.set(selector, value);
    }
    if (conditions.size !== selectorNames.length) {
      fail(`variant key "${key}" must give a value for every selector`);
    }
    variants.push({ conditions, parts: parsePattern(pattern, fail) });
  }
  if (!variants.some((v) => [...v.conditions.values()].every((value) => value === '*'))) {
    fail('a variant message needs a fallback variant with * for every selector');
  }
  return { inputs, locals, selectors: selectorNames, variants };
}

function compile(locale: string, key: string, raw: unknown): CompiledMessage {
  const fail: (reason: string) => never = (reason) => {
    throw new CatalogError(locale, key, reason);
  };
  if (typeof raw === 'string') {
    return { parts: parsePattern(raw, fail) };
  }
  if (isList(raw)) {
    return compileComplex(raw, fail);
  }
  return fail('must be a string or a variant array');
}

/** Values a message can take. Numbers are formatted for the locale. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** A compiled catalog for one locale. */
export class Catalog {
  readonly locale: string;
  readonly #messages: ReadonlyMap<string, CompiledMessage>;

  constructor(locale: string, json: Readonly<Record<string, unknown>>) {
    this.locale = locale;
    const messages = new Map<string, CompiledMessage>();
    for (const [key, raw] of Object.entries(json)) {
      if (key === '$schema') {
        continue;
      }
      if (!NAME.test(key)) {
        throw new CatalogError(locale, key, 'message ids must be snake_case identifiers');
      }
      messages.set(key, compile(locale, key, raw));
    }
    this.#messages = messages;
  }

  has(key: string): boolean {
    return this.#messages.has(key);
  }

  keys(): string[] {
    return [...this.#messages.keys()];
  }

  /** Every variable a message reads, in any variant. */
  variables(key: string): Set<string> {
    const message = this.#messages.get(key);
    const out = new Set<string>();
    if (message === undefined) {
      return out;
    }
    const collect = (parts: readonly Part[]): void => {
      for (const part of parts) {
        if ('variable' in part) {
          out.add(part.variable);
        }
      }
    };
    if ('parts' in message) {
      collect(message.parts);
    } else {
      for (const input of message.inputs) {
        out.add(input);
      }
      for (const variant of message.variants) {
        collect(variant.parts);
      }
    }
    return out;
  }

  /**
   * Formats `key`, returning literal text and the names of placeholders in order, so the HTML
   * renderer can wrap a placeholder in a link. Throws when a variable has no value.
   */
  formatParts(
    key: string,
    params: MessageParams,
    formatTag: string,
  ): ({ readonly text: string } | { readonly variable: string; readonly text: string })[] {
    const message = this.#messages.get(key);
    if (message === undefined) {
      throw new CatalogError(this.locale, key, 'no such message');
    }
    const display = (name: string): string => {
      const value = params[name];
      if (value === undefined) {
        throw new CatalogError(this.locale, key, `no value given for {${name}}`);
      }
      return typeof value === 'number' ? new Intl.NumberFormat(formatTag).format(value) : value;
    };
    const render = (parts: readonly Part[]) =>
      parts.map((part) =>
        'variable' in part ? { variable: part.variable, text: display(part.variable) } : part,
      );
    if ('parts' in message) {
      return render(message.parts);
    }
    return render(this.#select(key, message, params, formatTag).parts);
  }

  #select(key: string, message: ComplexMessage, params: MessageParams, formatTag: string): Variant {
    const selected = new Map<string, string>();
    for (const selector of message.selectors) {
      const local = message.locals.get(selector);
      const inputName = local?.input ?? selector;
      const value = params[inputName];
      if (value === undefined) {
        throw new CatalogError(this.locale, key, `no value given for {${inputName}}`);
      }
      if (local?.kind === 'plural') {
        if (typeof value !== 'number') {
          throw new CatalogError(this.locale, key, `{${inputName}} must be a number`);
        }
        selected.set(selector, new Intl.PluralRules(formatTag).select(value));
      } else {
        selected.set(selector, String(value));
      }
    }
    let best: Variant | undefined;
    let bestScore = -1;
    for (const variant of message.variants) {
      let score = 0;
      let matches = true;
      for (const [selector, want] of variant.conditions) {
        if (want === '*') {
          continue;
        }
        if (selected.get(selector) !== want) {
          matches = false;
          break;
        }
        score += 1;
      }
      if (matches && score > bestScore) {
        best = variant;
        bestScore = score;
      }
    }
    if (best === undefined) {
      throw new CatalogError(this.locale, key, 'no variant matched');
    }
    return best;
  }
}

/** Languages written right to left. */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ku',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

export type Direction = 'ltr' | 'rtl';

export function directionOf(tag: string): Direction {
  const language = new Intl.Locale(tag).language;
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

export interface ResolvedLocale {
  /** The catalog the copy comes from. */
  readonly catalog: string;
  /** The tag for the `lang` attribute and for number and date formats. */
  readonly tag: string;
}

/**
 * Picks the catalog for a requested locale: the exact tag, then its language, then `base`.
 * A regional variant of a shipped language (en-GB for en) keeps its tag for dates and numbers.
 */
export function resolveLocale(
  requested: string | undefined,
  available: ReadonlySet<string>,
  base: string,
): ResolvedLocale {
  if (requested === undefined) {
    return { catalog: base, tag: base };
  }
  if (available.has(requested)) {
    return { catalog: requested, tag: requested };
  }
  const language = new Intl.Locale(requested).language;
  if (available.has(language)) {
    return { catalog: language, tag: requested };
  }
  return { catalog: base, tag: base };
}
