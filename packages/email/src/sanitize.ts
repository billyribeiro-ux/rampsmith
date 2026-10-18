/**
 * Text hygiene for every value that reaches an email (ADR-193).
 *
 * Inputs come from Shopify (store names), from other users (agency names), from the engine
 * (finding titles) and from operators (incident notices). Before anything is formatted, each
 * value is made well formed and stripped of characters that can disguise what a reader sees:
 * control characters, and the explicit bidirectional overrides and isolates that can reorder a
 * line ("Trojan Source"). Direction is isolated by the HTML renderer instead (`<bdi>`).
 */

/** C0 and C1 control characters and DEL. */
export function isControlCharacter(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}
/** Explicit embeddings, overrides and isolates (LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI). */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/gu;
/**
 * Invisible characters that carry no meaning in a name or notice and can split a word past a
 * filter: byte order mark, soft hyphen, zero-width space and word joiner. The zero-width
 * joiner and non-joiner stay, because emoji sequences and several scripts need them.
 */
const INVISIBLE = /[\uFEFF\u00AD\u200B\u2060]/gu;
/** More than this many combining marks in a row is never language, only a size attack. */
const MARK_RUN = /(\p{M}{8})\p{M}+/gu;
/** Line breaks in every form JavaScript and Unicode know. */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/gu;

function clean(value: string): string {
  let out = '';
  for (const c of value
    .toWellFormed()
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(BIDI_CONTROL, '')
    .replace(MARK_RUN, '$1')) {
    if (c === '\t') {
      out += ' ';
    } else if (c === '\n' || !isControlCharacter(c)) {
      out += c;
    }
  }
  return out;
}

/** One line of text: every run of whitespace, line breaks included, becomes one space. */
export function singleLine(value: string): string {
  return clean(value.replace(LINE_BREAK, ' ')).replace(/\s+/gu, ' ').trim();
}

/**
 * Paragraphs of text: line breaks are kept (at most one blank line in a row), spaces inside a
 * line collapse, and every line is trimmed.
 */
export function multiLine(value: string): string {
  return clean(value.replace(LINE_BREAK, '\n'))
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Number of user-perceived characters. */
export function graphemeLength(value: string): number {
  let count = 0;
  const segments = graphemes.segment(value)[Symbol.iterator]();
  while (segments.next().done !== true) {
    count += 1;
  }
  return count;
}

/**
 * Shortens `value` to at most `max` user-perceived characters, ending with an ellipsis when
 * anything was cut. Never splits a grapheme cluster (an emoji sequence, a letter with marks).
 */
export function truncate(value: string, max: number): string {
  if (max < 1) {
    throw new RangeError('max must be at least 1');
  }
  if (graphemeLength(value) <= max) {
    return value;
  }
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (count === max - 1) {
      break;
    }
    out += segment;
    count += 1;
  }
  return `${out.trimEnd()}…`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for HTML element content and for double-quoted attribute values alike. Every
 * string the HTML renderer writes passes through here unless it is markup the renderer built.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => HTML_ESCAPES[c] ?? c);
}

/** Whether a header value or address could break out of its line (header injection). */
export function hasLineBreak(value: string): boolean {
  return /[\r\n\u0085\u2028\u2029]/u.test(value);
}
