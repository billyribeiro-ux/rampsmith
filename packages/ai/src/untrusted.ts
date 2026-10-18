/**
 * Handling of untrusted text: merchant content, page HTML and theme source flow into prompts
 * (PLAN §18: "Untrusted text is passed as delimited data"; ADR-213).
 *
 * The defence does not rely on any one of these functions. Claude gets no tools and no
 * secrets, every output must match a JSON Schema and pass the task's own checks, and nothing
 * AI-written ships without human approval. These functions keep the data honest on the way in:
 * no invisible characters, no personal data, no way to close the data block early.
 */

/**
 * Characters that render as nothing or reorder text: C0 and C1 controls (except tab and
 * newline), bidirectional controls, zero-width characters, the Unicode tag block and the
 * supplementary variation selectors, all of which have been used to hide instructions from
 * human reviewers while a model still reads them.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Normalizes untrusted text for a prompt: NFC, invisible characters removed, carriage returns
 * turned into newlines, trimmed, and cut to `maxGraphemes` user-perceived characters.
 */
export function sanitizeUntrustedText(text: string, maxGraphemes: number): string {
  let cleaned = '';
  for (const char of text.normalize('NFC').replace(/\r\n?/gu, '\n')) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) {
      cleaned += char;
    }
  }
  cleaned = cleaned.trim();
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(cleaned)) {
    if (count === maxGraphemes) {
      return out;
    }
    out += segment;
    count += 1;
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
/** A run of digits with phone-style separators, not inside a word (so SKUs survive). */
const DIGIT_RUN = /(?<![\w+])\+?\(?\d[\d\s().-]{7,}\d(?![\w])/gu;

/**
 * Replaces personal data patterns with placeholders (PLAN §18 scrubbing; §19: Anthropic
 * receives no personal data). Emails become `[email]`; digit runs of 9 to 15 digits become
 * `[phone]` (13 or more without a leading `+` become `[number]`, which covers card numbers).
 */
export function scrubPersonalData(text: string): string {
  return text.replace(EMAIL, '[email]').replace(DIGIT_RUN, (match) => {
    const digits = match.replace(/\D/gu, '').length;
    if (digits < 9) {
      return match;
    }
    if (digits >= 13 && !match.startsWith('+')) {
      return '[number]';
    }
    return digits <= 15 ? '[phone]' : '[number]';
  });
}

/**
 * Keeps a link target's scheme, host and path only. Query strings and fragments can carry
 * tracking ids, tokens or personal data and never help a model name a link. Anything but an
 * http(s) URL or a site-relative path becomes the empty string.
 */
export function stripQueryAndFragment(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed.replace(/[?#].*$/su, '');
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Tags that delimit data in prompts. Fixed names, so data can never choose its own. */
export type DataTag =
  | 'merchant_data'
  | 'rendered_element'
  | 'candidates'
  | 'theme_source'
  | 'rule'
  | 'alt_text_under_review';

/**
 * Serializes data as JSON inside `<tag>` … `</tag>`. `<`, `>` and `&` are escaped as JSON
 * Unicode escapes, so no value can close the block or open another tag, yet the JSON still
 * parses to exactly the original values. U+2028 and U+2029 are escaped too.
 */
export function encodeDataBlock(tag: DataTag, data: unknown): string {
  const json = JSON.stringify(data, null, 1)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
  return `<${tag}>\n${json}\n</${tag}>`;
}

const INSTRUCTION_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  {
    id: 'override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|these|those|the|your)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules|directions|guidelines)\b/iu,
  },
  { id: 'persona', pattern: /\byou are now\b/iu },
  { id: 'system-prompt', pattern: /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/iu },
  { id: 'role-label', pattern: /^\s*(?:system|assistant|user|human)\s*:/imu },
  {
    id: 'markup',
    pattern:
      /<\/?\s*(?:system|assistant|user|human|instructions?|merchant_data|rendered_element|candidates|theme_source|rule|alt_text_under_review)\b[^>]*>/iu,
  },
  { id: 'new-instructions', pattern: /\bnew\s+instructions?\b/iu },
];

/**
 * Heuristic signals that text is trying to instruct a model. A signal never blocks a call by
 * itself (the architecture is the defence); it marks the result for review so that bulk
 * approval skips it, and a model output carrying one is rejected.
 */
export function detectInstructionLikeText(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}
