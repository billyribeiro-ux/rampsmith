// Message catalogs in the inlang message format that apps/web's Paraglide catalogs use
// (PLAN §8; ADR-222): one JSON file per locale in messages/, simple messages with `{name}`
// placeholders and `\{` `\}` escapes, and plural messages as one variant object with an
// `input`, a `local ... : plural` declaration and a `*` catch-all. English ships first; a new
// language is a new file registered in CATALOGS, and the catalog test proves it has every key,
// placeholder and catch-all English has.
import en from '../messages/en.json' with { type: 'json' };
import type { Inline, Link } from './blocks.ts';
import { markup, join, text, type Html, type HtmlValue } from './html.ts';

export type MessageKey = Exclude<keyof typeof en, '$schema'>;

type Part = { readonly text: string } | { readonly name: string };

type PluralCategory = Intl.LDMLPluralRule | '*';

type Message =
  | { readonly kind: 'simple'; readonly pattern: readonly Part[] }
  | {
      readonly kind: 'plural';
      readonly input: string;
      readonly forms: ReadonlyMap<PluralCategory, readonly Part[]>;
    };

export type Catalog = ReadonlyMap<string, Message>;

const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PLURAL_CATEGORIES: readonly PluralCategory[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
  '*',
];

function parsePattern(key: string, source: string): Part[] {
  const parts: Part[] = [];
  let literal = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      if (next === '{' || next === '}' || next === '\\') {
        literal += next;
        i += 1;
        continue;
      }
      throw new Error(`message "${key}": "\\" must escape "{", "}" or "\\"`);
    }
    if (ch === '}') {
      throw new Error(`message "${key}": unmatched "}"`);
    }
    if (ch === '{') {
      const end = source.indexOf('}', i);
      if (end === -1) {
        throw new Error(`message "${key}": unclosed placeholder`);
      }
      const name = source.slice(i + 1, end);
      if (!PLACEHOLDER_NAME.test(name)) {
        throw new Error(`message "${key}": placeholder {${name}} must be a bare variable name`);
      }
      if (literal !== '') {
        parts.push({ text: literal });
        literal = '';
      }
      parts.push({ name });
      i = end;
      continue;
    }
    literal += ch;
  }
  if (literal !== '') {
    parts.push({ text: literal });
  }
  return parts;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlural(key: string, value: readonly unknown[]): Message {
  const fail = (why: string): never => {
    throw new Error(`message "${key}": plural message ${why}`);
  };
  const variant = value[0];
  if (value.length !== 1 || !isRecord(variant)) {
    return fail('must be an array holding one variant object');
  }
  const { declarations, selectors, match } = variant;
  if (!Array.isArray(declarations) || !Array.isArray(selectors) || !isRecord(match)) {
    return fail('needs "declarations", "selectors" and "match"');
  }
  const input = /^input ([A-Za-z_]\w*)$/u.exec(String(declarations[0]))?.[1];
  const local = /^local ([A-Za-z_]\w*) = ([A-Za-z_]\w*): plural$/u.exec(String(declarations[1]));
  const selector = local?.[1];
  if (
    declarations.length !== 2 ||
    input === undefined ||
    selector === undefined ||
    local?.[2] !== input ||
    selectors.length !== 1 ||
    selectors[0] !== selector
  ) {
    return fail('must declare "input <n>" and "local <p> = <n>: plural", and select on <p> alone');
  }
  const forms = new Map<PluralCategory, Part[]>();
  for (const [matchKey, pattern] of Object.entries(match)) {
    const category = matchKey.startsWith(`${selector}=`)
      ? matchKey.slice(selector.length + 1)
      : undefined;
    const known = PLURAL_CATEGORIES.find((c) => c === category);
    if (known === undefined) {
      return fail(
        `has match key "${matchKey}"; use ${selector}=<plural category> or ${selector}=*`,
      );
    }
    if (typeof pattern !== 'string') {
      return fail(`form "${matchKey}" must be a string`);
    }
    forms.set(known, parsePattern(key, pattern));
  }
  if (!forms.has('*')) {
    return fail(`needs a "${selector}=*" catch-all form`);
  }
  return { kind: 'plural', input, forms };
}

/** Validates the parsed JSON of one catalog file. Throws on any malformed message. */
export function parseCatalog(input: unknown): Catalog {
  if (!isRecord(input)) {
    throw new Error('a catalog must be a JSON object');
  }
  const catalog = new Map<string, Message>();
  for (const [key, value] of Object.entries(input)) {
    if (key === '$schema') {
      continue;
    }
    if (typeof value === 'string') {
      catalog.set(key, { kind: 'simple', pattern: parsePattern(key, value) });
    } else if (Array.isArray(value)) {
      catalog.set(key, parsePlural(key, value));
    } else {
      throw new Error(`message "${key}" must be a string or a plural variant array`);
    }
  }
  return catalog;
}

export const CATALOGS = { en: parseCatalog(en) } as const satisfies Record<string, Catalog>;

export type Locale = keyof typeof CATALOGS;

export const LOCALES = Object.keys(CATALOGS) as readonly Locale[];

const BASE_LOCALE: Locale = 'en';

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The catalog for a requested BCP 47 tag, matched on its language subtag. A language without
 * a catalog falls back to English, and `fallback` says so, so callers can tell the merchant.
 */
export function resolveLocale(requested: string): { locale: Locale; fallback: boolean } {
  const language = requested.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  return isLocale(language)
    ? { locale: language, fallback: false }
    : { locale: BASE_LOCALE, fallback: true };
}

function placeholders(message: Message): string[] {
  const patterns = message.kind === 'simple' ? [message.pattern] : [...message.forms.values()];
  const names = new Set<string>(message.kind === 'plural' ? [message.input] : []);
  for (const pattern of patterns) {
    for (const part of pattern) {
      if ('name' in part) names.add(part.name);
    }
  }
  return [...names].sort();
}

/** Every difference between a translation and the base catalog; empty when they agree. */
export function checkCatalog(base: Catalog, other: Catalog): string[] {
  const problems: string[] = [];
  const keys = [...new Set([...base.keys(), ...other.keys()])].sort();
  for (const key of keys) {
    const want = base.get(key);
    const got = other.get(key);
    if (want === undefined) {
      problems.push(`${key}: not in the base catalog`);
    } else if (got === undefined) {
      problems.push(`${key}: missing`);
    } else {
      const a = placeholders(want).join(',');
      const b = placeholders(got).join(',');
      if (a !== b) {
        const brace = (s: string): string =>
          s === ''
            ? 'none'
            : s
                .split(',')
                .map((n) => `{${n}}`)
                .join(' ');
        problems.push(`${key}: placeholders ${brace(b)} differ from ${brace(a)}`);
      }
      if (want.kind !== got.kind) {
        problems.push(`${key}: ${got.kind} message where the base has a ${want.kind} one`);
      }
    }
  }
  return problems;
}

type TextParams = Readonly<Record<string, string | number>>;
type HtmlParams = Readonly<Record<string, Html | string | number>>;
type RichParams = Readonly<Record<string, Link | string | number>>;

export interface Translator {
  readonly locale: Locale;
  /** True when the requested locale had no catalog and English was used. */
  readonly fallback: boolean;
  text(key: MessageKey, params?: TextParams): string;
  html(key: MessageKey, params?: HtmlParams): Html;
  /** The message as text and links, for the block model that renders both HTML and text. */
  rich(key: MessageKey, params?: RichParams): Inline[];
  /** A calendar date in UTC, such as "October 17, 2026". */
  date(value: Date): string;
  number(value: number): string;
  /** A ratio between 0 and 1 as a percentage, to one decimal place at most. */
  percent(ratio: number): string;
  /** "a, b and c", joined the way the locale joins a list. */
  list(items: readonly string[]): string;
}

export function translator(requested: string): Translator {
  const { locale, fallback } = resolveLocale(requested);
  const catalog: Catalog = CATALOGS[locale];
  const numbers = new Intl.NumberFormat(locale);
  const percents = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const plurals = new Intl.PluralRules(locale);
  const lists = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });

  function pattern(key: MessageKey, params: Readonly<Record<string, unknown>>): readonly Part[] {
    const message = catalog.get(key);
    if (message === undefined) {
      throw new Error(`message "${key}" is missing from the ${locale} catalog`);
    }
    if (message.kind === 'simple') {
      return message.pattern;
    }
    const count = params[message.input];
    if (typeof count !== 'number') {
      throw new Error(`message "${key}" needs the number {${message.input}}`);
    }
    const forms = message.forms;
    return forms.get(plurals.select(count)) ?? forms.get('*') ?? [];
  }

  function param(
    key: MessageKey,
    params: Readonly<Record<string, unknown>>,
    name: string,
  ): unknown {
    if (!Object.hasOwn(params, name)) {
      throw new Error(`message "${key}" needs the parameter {${name}}`);
    }
    const value = params[name];
    return typeof value === 'number' ? numbers.format(value) : value;
  }

  return {
    locale,
    fallback,
    text(key, params = {}) {
      return pattern(key, params)
        .map((part) => ('text' in part ? part.text : String(param(key, params, part.name))))
        .join('');
    },
    html(key, params = {}) {
      return join(
        pattern(key, params).map((part) => {
          if ('text' in part) return text(part.text);
          const value = param(key, params, part.name) as HtmlValue;
          return markup`${value}`;
        }),
      );
    },
    rich(key, params = {}) {
      return pattern(key, params).map((part) =>
        'text' in part ? part.text : (param(key, params, part.name) as Inline),
      );
    },
    date(value) {
      if (Number.isNaN(value.getTime())) {
        throw new RangeError('cannot format an invalid date');
      }
      return dates.format(value);
    },
    number(value) {
      return numbers.format(value);
    },
    percent(ratio) {
      return percents.format(ratio);
    },
    list(items) {
      return lists.format(items);
    },
  };
}
