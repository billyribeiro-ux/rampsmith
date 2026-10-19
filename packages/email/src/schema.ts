/**
 * Runtime validation of email inputs (ADR-193). Inputs reach `render` from TypeScript callers
 * and, through the job queue, as JSON written by Rust; both go through the same schema, which
 * also gives the static input and output types. Unknown keys are rejected so that a payload
 * cannot carry personal data a template does not need. Error messages name the field and the
 * rule, never the value, because a value may be a token.
 */
import { parseLink, type OriginName, type Origins, type SafeUrl } from './links.ts';
import { graphemeLength, multiLine, singleLine, skeleton, truncate } from './sanitize.ts';

declare const inputType: unique symbol;

interface ParseContext {
  readonly origins: Origins;
}

export interface Schema<I, O> {
  /** Type-level only: what callers pass. */
  readonly [inputType]?: I;
  readonly optional: boolean;
  parse(value: unknown, path: string, ctx: ParseContext): O;
}

export interface OptionalSchema<I, O> extends Schema<I | undefined, O | undefined> {
  readonly optional: true;
}

type AnySchema = Schema<unknown, unknown>;
export type InputOf<S> = S extends Schema<infer I, unknown> ? I : never;
export type OutputOf<S> = S extends Schema<unknown, infer O> ? O : never;

/** An input failed validation. `path` names the field, such as `input.fixes[2].title`. */
export class InputError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'InputError';
    this.path = path;
    this.reason = reason;
  }
}

function schema<I, O>(parse: (value: unknown, path: string, ctx: ParseContext) => O): Schema<I, O> {
  return { optional: false, parse };
}

function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new InputError(path, `must be a string, not ${typeName(value)}`);
  }
  return value;
}

/**
 * A name or title shown on one line: store, agency, finding or fix names. Whitespace collapses,
 * hidden characters go, and text longer than `max` user-perceived characters is shortened with
 * an ellipsis, because these values come from systems Rampsmith does not control.
 */
export function label(max: number): Schema<string, string> {
  return schema((value, path) => {
    // Bound the work before cleaning: no name needs more than 16 code units per character.
    const raw = expectString(value, path);
    const text = singleLine(raw.length > max * 16 ? raw.slice(0, max * 16) : raw);
    if (text.length === 0) {
      throw new InputError(path, 'must not be empty');
    }
    return truncate(text, max);
  });
}

/**
 * Looks like a link, an address or a domain: `scheme://`, `www.`, `@`, or a dotted name
 * ending in letters (`example.com`). Mail clients turn such text into links.
 */
const LINK_LIKE =
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|@|[\p{L}\p{N}-]\.\p{L}{2,}(?![\p{L}\p{N}])|\b\d{1,3}(?:\.\d{1,3}){3}\b|\\\\/iu;

/**
 * Whether `text` reads as a link, an address, a domain, an IPv4 address or a network path,
 * judged on its {@link skeleton}, so look-alike dots and hidden characters do not hide one.
 */
export function looksLinkLike(text: string): boolean {
  return LINK_LIKE.test(skeleton(text));
}

/**
 * A name another user chose, shown to someone who did not ask for the email: an agency name in
 * an invitation, a store name in a store-link code sent to any address. Such a name must not
 * read as a link or an address, or Rampsmith's signed mail would carry someone's phishing
 * link (ADR-193). The app's own name rules should match, so this rarely fires at send time.
 */
export function displayName(max: number): Schema<string, string> {
  const inner = label(max);
  return schema((value, path, ctx) => {
    const text = inner.parse(value, path, ctx);
    if (looksLinkLike(text)) {
      throw new InputError(path, 'must not contain a link, an email address or a domain name');
    }
    return text;
  });
}

/**
 * Paragraphs written by an operator, such as an incident notice. Line breaks are kept; text
 * longer than `max` characters is rejected rather than cut, so nothing an operator wrote is
 * silently lost.
 */
export function prose(max: number): Schema<string, string> {
  return schema((value, path) => {
    const raw = expectString(value, path);
    if (raw.length > max * 16) {
      throw new InputError(path, `must be at most ${String(max)} characters`);
    }
    const text = multiLine(raw);
    if (text.length === 0) {
      throw new InputError(path, 'must not be empty');
    }
    if (graphemeLength(text) > max) {
      throw new InputError(path, `must be at most ${String(max)} characters`);
    }
    return text;
  });
}

/** A whole number in `[min, max]`. */
export function int(min: number, max: number): Schema<number, number> {
  return schema((value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new InputError(path, 'must be a whole number');
    }
    if (value < min || value > max) {
      throw new InputError(path, `must be between ${String(min)} and ${String(max)}`);
    }
    return value;
  });
}

/** A count of things: a whole number from 0 to one billion. */
export function count(): Schema<number, number> {
  return int(0, 1_000_000_000);
}

export function bool(): Schema<boolean, boolean> {
  return schema((value, path) => {
    if (typeof value !== 'boolean') {
      throw new InputError(path, 'must be true or false');
    }
    return value;
  });
}

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number], T[number]> {
  const isMember = (value: unknown): value is T[number] =>
    typeof value === 'string' && values.includes(value);
  return schema((value, path) => {
    if (!isMember(value)) {
      throw new InputError(path, `must be one of: ${values.join(', ')}`);
    }
    return value;
  });
}

/** A string matching `pattern` exactly, such as a WCAG criterion number. */
export function pattern(re: RegExp, description: string): Schema<string, string> {
  return schema((value, path) => {
    const text = expectString(value, path);
    if (!re.test(text)) {
      throw new InputError(path, `must be ${description}`);
    }
    return text;
  });
}

/** A WCAG success criterion number, such as `1.1.1` or `2.4.11`. */
export function criterion(): Schema<string, string> {
  return pattern(/^[1-4]\.[0-9]{1,2}\.[0-9]{1,2}$/u, 'a WCAG success criterion number like 1.4.3');
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

/** Whether the calendar and clock fields are in range (no 30 February, no 24:00). */
function validFields(match: RegExpExecArray): boolean {
  // An optional group that did not match (seconds, offset) is undefined.
  const field = (index: number): number => Number(match[index] ?? '0');
  const year = field(1);
  const month = field(2);
  const day = field(3);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    field(4) <= 23 &&
    field(5) <= 59 &&
    field(6) <= 59 &&
    field(7) <= 23 &&
    field(8) <= 59
  );
}

/** An RFC 3339 instant with an explicit offset, as `time` and `Date#toISOString` write it. */
export function instant(): Schema<string, Date> {
  return schema((value, path) => {
    const text = expectString(value, path);
    const match = ISO_INSTANT.exec(text);
    if (match === null || !validFields(match)) {
      throw new InputError(path, 'must be an RFC 3339 date and time with an offset');
    }
    const date = new Date(text);
    const year = date.getUTCFullYear();
    if (Number.isNaN(date.getTime()) || year < 2000 || year > 2200) {
      throw new InputError(path, 'must be a real date between the years 2000 and 2200');
    }
    return date;
  });
}

/** A link to one of `allowed` origins (see links.ts). */
export function link(allowed: readonly OriginName[]): Schema<string, SafeUrl> {
  return schema((value, path, ctx) => {
    const url = parseLink(expectString(value, path), allowed, ctx.origins);
    if (url === null) {
      throw new InputError(
        path,
        `must be an absolute link on the ${allowed.join(' or ')} origin, without credentials`,
      );
    }
    return url;
  });
}

/** A host name such as `shop.example`, returned in its ASCII (punycode) form. */
export function hostname(): Schema<string, string> {
  return schema((value, path) => {
    const text = expectString(value, path);
    const invalid = new InputError(path, 'must be a plain host name such as shop.example');
    if (text.length === 0 || text.length > 253 || !/^[^\s/\\?#@:[\]%]+$/u.test(text)) {
      throw invalid;
    }
    const candidate = `https://${text}/`;
    if (!URL.canParse(candidate)) {
      throw invalid;
    }
    const host = new URL(candidate).hostname;
    // Letters, digits and hyphens in dot-separated labels, ending in a letter label: no IP
    // literals, no trailing dot, nothing the URL parser let through but DNS would not.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u.test(host)) {
      throw invalid;
    }
    return host;
  });
}

/** A BCP 47 language tag, canonicalised. */
export function localeTag(): Schema<string, string> {
  return schema((value, path) => {
    const text = expectString(value, path);
    try {
      const [canonical] = text.length <= 35 ? Intl.getCanonicalLocales(text) : [];
      if (canonical !== undefined) {
        // Language, script and region only: extensions such as -u-nu- would change digits.
        return new Intl.Locale(canonical).baseName;
      }
    } catch {
      // Falls through to the error below.
    }
    throw new InputError(path, 'must be a BCP 47 language tag such as en or en-GB');
  });
}

/** An IANA time zone name such as `Europe/Berlin`. */
export function timeZone(): Schema<string, string> {
  return schema((value, path) => {
    const text = expectString(value, path);
    try {
      if (text.length <= 64) {
        return new Intl.DateTimeFormat('en', { timeZone: text }).resolvedOptions().timeZone;
      }
    } catch {
      // Falls through to the error below.
    }
    throw new InputError(path, 'must be an IANA time zone such as Europe/Berlin');
  });
}

/** Makes a field optional: absent and `undefined` both mean "not given". */
export function optional<I, O>(inner: Schema<I, O>): OptionalSchema<I, O> {
  return {
    optional: true,
    parse(value, path, ctx) {
      return value === undefined ? undefined : inner.parse(value, path, ctx);
    },
  };
}

/** An array of at most `max` items (at least `min`). */
export function list<I, O>(
  item: Schema<I, O>,
  { min = 0, max }: { readonly min?: number; readonly max: number },
): Schema<readonly I[], readonly O[]> {
  return schema((value, path, ctx) => {
    if (!Array.isArray(value)) {
      throw new InputError(path, `must be an array, not ${typeName(value)}`);
    }
    if (value.length < min || value.length > max) {
      throw new InputError(path, `must hold ${String(min)} to ${String(max)} items`);
    }
    return value.map((entry: unknown, index) =>
      item.parse(entry, `${path}[${String(index)}]`, ctx),
    );
  });
}

type Shape = Readonly<Record<string, AnySchema>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type ObjectInput<S extends Shape> = Simplify<
  { readonly [K in RequiredKeys<S>]: InputOf<S[K]> } & {
    readonly [K in OptionalKeys<S>]?: Exclude<InputOf<S[K]>, undefined>;
  }
>;
export type ObjectOutput<S extends Shape> = Simplify<
  { readonly [K in RequiredKeys<S>]: OutputOf<S[K]> } & {
    readonly [K in OptionalKeys<S>]?: Exclude<OutputOf<S[K]>, undefined>;
  }
>;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An object with exactly the fields of `shape`; any other key is an error. */
export function object<const S extends Shape>(shape: S): Schema<ObjectInput<S>, ObjectOutput<S>> {
  return schema((value, path, ctx) => {
    if (!isPlainObject(value)) {
      throw new InputError(path, `must be an object, not ${typeName(value)}`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) {
        // A key is input too: name it only when it is a plain identifier, so an error never
        // carries an address or a forged log line.
        const shown = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) ? key : '<unknown field>';
        throw new InputError(`${path}.${shown}`, 'is not a field of this email');
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const parsed = field.parse(value[key], `${path}.${key}`, ctx);
      if (parsed === undefined) {
        if (!field.optional) {
          throw new InputError(`${path}.${key}`, 'is required');
        }
        continue;
      }
      out[key] = parsed;
    }
    return out as ObjectOutput<S>;
  });
}

/** Adds a rule across fields, such as "passed must not exceed total", reported on `field`. */
export function refine<I, O>(
  inner: Schema<I, O>,
  test: (value: O) => boolean,
  field: string,
  reason: string,
): Schema<I, O> {
  return {
    optional: inner.optional,
    parse(value, path, ctx) {
      const parsed = inner.parse(value, path, ctx);
      if (!test(parsed)) {
        throw new InputError(`${path}.${field}`, reason);
      }
      return parsed;
    },
  };
}
