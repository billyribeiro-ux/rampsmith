// Every value a merchant or a scan supplies reaches HTML, plain text, CSV and PDF only through
// these functions (ADR-222). Text is escaped, never parsed; links are built only from values
// that validate, so no input can add markup, a script, or a request to the rendered page.

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Escapes text for an HTML text node or a double-quoted attribute value. Backticks are
 * escaped too, because some legacy parsers treat them as attribute quotes.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/gu, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * C0 and C1 controls other than tab and line feed, DEL, the explicit bidirectional embedding,
 * override and isolate controls (U+202A–U+202E, U+2066–U+2069), which could make a
 * merchant-supplied name reorder the report text around it, and the invisible characters that
 * carry no meaning in report text: zero width space (U+200B), word joiner and the invisible
 * operators (U+2060–U+2064), and the byte-order mark (U+FEFF). The joiners U+200C and U+200D
 * and the implicit marks U+200E, U+200F and U+061C stay: Persian, Indic scripts, emoji and
 * right-to-left text need them.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/**
 * Cleans free text before it is rendered anywhere: normalizes line endings, including the
 * Unicode line and paragraph separators, to LF; removes unsafe and invisible characters; and
 * replaces lone surrogates with U+FFFD.
 */
export function sanitizeText(text: string): string {
  return text
    .toWellFormed()
    .replace(/\r\n?|[\u2028\u2029]/gu, '\n')
    .replace(UNSAFE, '');
}

/** Longest URL accepted, before and after serialization (percent-encoding can grow it). */
const MAX_URL = 2_048;

/**
 * Returns the serialized URL when `input` is an absolute `https:` or `http:` URL without
 * credentials, and `undefined` otherwise. Only URLs that pass become `href` values.
 */
export function safeWebUrl(input: string): string | undefined {
  if (input.length > MAX_URL || input !== input.trim() || !/^https?:\/\//iu.test(input)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.href.length > MAX_URL
  ) {
    return undefined;
  }
  return url.href;
}

/** Characters an address in a `mailto:` link may not contain: whitespace, quotes, markup, query syntax. */
const EMAIL =
  /^[^\s@<>()[\]"'`,;:\\?&=#%/]+@[^\s@<>()[\]"'`,;:\\?&=#%/]+\.[^\s@<>()[\]"'`,;:\\?&=#%/.]+$/u;

/** A deliberately strict address check: one `@`, a dotted domain, nothing that alters a link. */
export function validEmail(input: string): boolean {
  return input.length <= 254 && EMAIL.test(input);
}

export function mailtoHref(email: string): string | undefined {
  return validEmail(email) ? `mailto:${email}` : undefined;
}

/**
 * A `tel:` link from a phone number written for people: digits and an optional leading plus
 * are kept, and spaces, dots, dashes and parentheses dropped. Anything else is refused.
 */
export function telHref(phone: string): string | undefined {
  if (!/^\+?[\d\s().-]+$/u.test(phone)) {
    return undefined;
  }
  const digits = phone.replace(/[^\d]/gu, '');
  if (digits.length < 3 || digits.length > 20) {
    return undefined;
  }
  return `tel:${phone.trimStart().startsWith('+') ? '+' : ''}${digits}`;
}
