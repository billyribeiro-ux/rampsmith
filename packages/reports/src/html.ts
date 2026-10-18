// HTML is built only through the `markup` tagged template (ADR-222): every interpolated string
// or number is sanitized and escaped, and only values that are already `Html` pass through.
// Merchant data therefore cannot become markup, whatever it contains.
import { escapeHtml, sanitizeText } from './escape.ts';

const KEY = Symbol('Html');

/** A fragment of markup produced by this package. It cannot be built from untrusted text. */
export class Html {
  readonly #value: string;

  constructor(key: symbol, value: string) {
    if (key !== KEY) {
      throw new TypeError('Html values are created only by markup`` and rawHtml()');
    }
    this.#value = value;
  }

  toString(): string {
    return this.#value;
  }
}

/** A value a `markup` template accepts. `false`, `null` and `undefined` render as nothing. */
export type HtmlValue = Html | string | number | false | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  if (value instanceof Html) {
    return value.toString();
  }
  if (typeof value === 'number') {
    return escapeHtml(String(value));
  }
  if (typeof value === 'string') {
    return escapeHtml(sanitizeText(value));
  }
  return value.map(render).join('');
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
export function rawHtml(markup: string): Html {
  return new Html(KEY, markup);
}

/** Escapes plain text into an `Html` value, for building markup piece by piece. */
export function text(value: string): Html {
  return new Html(KEY, render(value));
}

export function join(parts: readonly Html[], separator = ''): Html {
  return new Html(KEY, parts.map(String).join(separator));
}
