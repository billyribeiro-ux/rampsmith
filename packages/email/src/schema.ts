/**
 * Runtime validation of email inputs (ADR-193). Inputs reach `render` from TypeScript callers
 * and, through the job queue, as JSON written by Rust; both go through the same schema, which
 * also gives the static input and output types. Unknown keys are rejected so that a payload
 * cannot carry personal data a template does not need. Error messages name the field and the
 * rule, never the value, because a value may be a token.
 */
import { parseLink, type OriginName, type Origins, type SafeUrl } from './links.ts';
import { graphemeLength, multiLine, singleLine, truncate } from './sanitize.ts';

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
    const text = singleLine(expectString(value, path));
    if (text.length === 0) {
      throw new InputError(path, 'must not be empty');
    }
    return truncate(text, max);
  });
}

/**
 * Paragraphs written by an operator, such as an incident notice. Line breaks are kept; text
 * longer than `max` characters is rejected rather than cut, so nothing an operator wrote is
 * silently lost.
 */
export function prose(max: number): Schema<string, string> {
  return schema((value, path) => {
    const text = multiLine(expectString(value, path));
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
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** An RFC 3339 instant with an explicit offset, as `time` and `Date#toISOString` write it. */
export function instant(): Schema<string, Date> {
  return schema((value, path) => {
    const text = expectString(value, path);
    if (!ISO_INSTANT.test(text)) {
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
    if (!host.includes('.') || /^[\d.]+$/u.test(host)) {
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
        return canonical;
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
        throw new InputError(`${path}.${key}`, 'is not a field of this email');
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
