// HTML is built only through the `markup` tagged template (ADR-222): every interpolated string
// or number is sanitized and escaped, and only values that are already `Html` pass through.
// Merchant data therefore cannot become markup, whatever it contains.
import { escapeHtml, sanitizeText } from './escape.ts';

const KEY = Symbol('Html');

/**
 * A fragment of markup produced by this package. It cannot be built from untrusted text: the
 * constructor needs a private key, the instance is frozen, and `Html.is` checks the private
 * field, so neither `Object.create(Html.prototype)` nor a look-alike object passes as one.
 */
export class Html {
  readonly #value: string;

  constructor(key: symbol, value: string) {
    if (key !== KEY) {
      throw new TypeError('Html values are created only by markup`` and rawHtml()');
    }
    this.#value = value;
    Object.freeze(this);
  }

  static is(value: unknown): value is Html {
    return typeof value === 'object' && value !== null && #value in value;
  }

  toString(): string {
    return this.#value;
  }
}

// Neither the class nor its prototype can be changed, so `Html.is` and `toString` stay ours.
Object.freeze(Html.prototype);
Object.freeze(Html);

/** A value a `markup` template accepts. `false`, `null` and `undefined` render as nothing. */
export type HtmlValue = Html | string | number | false | null | undefined | readonly HtmlValue[];

function render(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  if (Html.is(value)) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    // Array.from, not the array's own `map`, which a caller could have replaced.
    return Array.from(value as readonly unknown[], render).join('');
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return escapeHtml(sanitizeText(String(value)));
  }
  // An object that only looks like Html, or anything else: refuse rather than guess.
  throw new TypeError('markup accepts only text, numbers and Html built by this package');
}

export function markup(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new Html(KEY, out);
}

/**
 * Trusted markup written in this package's own source, such as a constant style sheet.
 * Never call it with text that came from an input.
 */
export function rawHtml(source: string): Html {
  return new Html(KEY, source);
}

/** Escapes plain text into an `Html` value, for building markup piece by piece. */
export function text(value: string): Html {
  return new Html(KEY, render(value));
}

/** Joins fragments; a part that is not genuine `Html` is refused. */
export function join(parts: readonly Html[], separator = ''): Html {
  return new Html(KEY, Array.from(parts, render).join(separator));
}
