/**
 * Handling of untrusted text: merchant content, page HTML and theme source flow into prompts,
 * and model output flows back into fixes (PLAN §18; ADR-213).
 *
 * The defence does not rely on any one of these functions. Claude gets no tools and no
 * secrets, every output must match a JSON Schema and pass the task's own checks, and nothing
 * AI-written ships without human approval. These functions keep the data honest: no invisible
 * characters, no personal data, no way to close a data block early, and every pattern bounded
 * so that a hostile input costs linear time (security audit HIGH-2).
 */

/**
 * Characters that render as nothing or reorder text: controls, format characters (bidi
 * controls, zero-width characters, the Unicode tag block), default-ignorable code points
 * (variation selectors, soft hyphens, Hangul fillers), lone surrogates and the blank Braille
 * cell U+2800. All have been used to hide text from human reviewers while a model still reads
 * it.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/u;
const INVISIBLE_GLOBAL = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** Tab, newline and carriage return: layout in code and prose, not hidden text. */
const LAYOUT = new Set(['\t', '\n', '\r']);

/** Whether `text` holds an invisible character other than tab, newline or carriage return. */
export function containsInvisible(text: string): boolean {
  for (const char of text) {
    if (!LAYOUT.has(char) && INVISIBLE.test(char)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether model output meant as one line of copy (alt text, link text, an attribute value)
 * holds any invisible character or line break.
 */
export function hasHiddenOrBreakingCharacters(text: string): boolean {
  return INVISIBLE.test(text) || /[\u2028\u2029]/u.test(text);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** A grapheme longer than this (a pile of combining marks) keeps only its first code point. */
const MAX_GRAPHEME_UNITS = 12;

function truncateGraphemes(text: string, maxGraphemes: number): string {
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (count === maxGraphemes) {
      break;
    }
    out +=
      segment.length > MAX_GRAPHEME_UNITS
        ? String.fromCodePoint(segment.codePointAt(0) ?? 0x20)
        : segment;
    count += 1;
  }
  return out;
}

/**
 * Normalizes untrusted text for a prompt: NFKC (which also folds look-alike delimiters such as
 * the fullwidth `＜` into `<`, escaped later), carriage returns turned into newlines, invisible
 * characters removed, trimmed, and cut to `maxGraphemes` user-perceived characters, each at
 * most 12 UTF-16 code units long.
 */
export function sanitizeUntrustedText(text: string, maxGraphemes: number): string {
  const cleaned = text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(INVISIBLE_GLOBAL, (c) => (c === '\t' || c === '\n' ? c : ''))
    .trim();
  return truncateGraphemes(cleaned, maxGraphemes);
}

/** Linear-time patterns: each starts only at the beginning of a run and is bounded. */
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}/gu;
const IBAN = /(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Z0-9])/gu;
/**
 * Email addresses spelled out to dodge filters: `jane [at] example [dot] com`, `jane(at)example.com`,
 * `jane dot doe at example dot com`. A bracketed `at` may be followed by any domain; a bare
 * `at` only by labels joined with a spelled `dot` that end in a common top-level domain, so
 * prose such as "made at our studio" or "look at the dot pattern" is left alone.
 */
const SPELLED_LOCAL = String.raw`(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}(?:(?:[ \t]{1,3}dot[ \t]{1,3}|[ \t]{0,3}[(\[{<]dot[)\]}>][ \t]{0,3})[\p{L}\p{N}_%+-]{1,64}){0,3}`;
const SPELLED_DOT = String.raw`(?:[ \t]{1,3}dot[ \t]{1,3}|[ \t]{0,3}[(\[{<]dot[)\]}>][ \t]{0,3})`;
const LABEL = String.raw`[\p{L}\p{N}-]{1,63}`;
const COMMON_TLD =
  'com|net|org|edu|gov|info|biz|io|co|me|us|uk|eu|de|fr|es|it|nl|be|ch|at|se|no|dk|fi|pl|pt|ie|ca|au|nz|br|mx|ar|jp|in|cn|ru';
const SPELLED_EMAIL_BRACKET = new RegExp(
  String.raw`${SPELLED_LOCAL}[ \t]{0,3}[(\[{<]at[)\]}>][ \t]{0,3}${LABEL}(?:(?:\.|${SPELLED_DOT})${LABEL}){1,8}`,
  'giu',
);
const SPELLED_EMAIL_WORD = new RegExp(
  String.raw`${SPELLED_LOCAL}[ \t]{1,3}at[ \t]{1,3}${LABEL}(?:${SPELLED_DOT}${LABEL}){0,7}${SPELLED_DOT}(?:${COMMON_TLD})(?![\p{L}\p{N}])`,
  'giu',
);
/** A run of digits with phone-style separators, not inside a word (so SKUs survive). */
const DIGIT_RUN = /(?<![\p{L}\p{N}_+])\+?\(?\p{Nd}[\p{Nd}\s()./_-]{7,40}\p{Nd}(?![\p{L}\p{N}_])/gu;

/**
 * Replaces personal data patterns with placeholders (PLAN §18 scrubbing; §19: Anthropic
 * receives no personal data). Emails, including ones spelled out with "at" and "dot", become
 * `[email]`, IBANs `[iban]`; digit runs of 9 to 15
 * digits in any script become `[phone]` (13 or more without a leading `+` become `[number]`,
 * which covers card numbers). Names cannot be found by pattern; rendered excerpts arrive
 * scrubbed by the engine (PLAN §9, §18).
 */
export function scrubPersonalData(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(SPELLED_EMAIL_BRACKET, '[email]')
    .replace(SPELLED_EMAIL_WORD, '[email]')
    .replace(IBAN, '[iban]')
    .replace(DIGIT_RUN, (match) => {
      const digits = match.replace(/\P{Nd}/gu, '').length;
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
 * Prepares one untrusted field for a prompt: sanitized with headroom, scrubbed, and only then
 * cut to `maxGraphemes`, so a cut can never leave half an email address behind.
 */
export function untrustedField(text: string, maxGraphemes: number): string {
  return truncateGraphemes(
    scrubPersonalData(sanitizeUntrustedText(text, maxGraphemes + 256)),
    maxGraphemes,
  );
}

/** A path segment that looks like a token or an id rather than a word. */
function looksLikeToken(segment: string): boolean {
  if (segment.length >= 24 && !/[-_.]/u.test(segment)) {
    return true;
  }
  return segment
    .split(/[-_.]/u)
    .some((part) => part.length >= 12 && /\d/u.test(part) && /[A-Za-z]/u.test(part));
}

/**
 * A link target as a model may see it: scheme, host and path only. Query strings, fragments
 * and `;` parameters can carry tracking ids, tokens or personal data and never help name a
 * link; token-like path segments become `[token]`, personal data is scrubbed, and the result is
 * at most 200 characters. Anything but an http(s) URL or a site-relative path becomes empty.
 */
export function safeLinkTarget(href: string): string {
  const trimmed = sanitizeUntrustedText(href, 2048);
  let host = '';
  let path: string;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    path = trimmed;
  } else {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return '';
      }
      host = `${url.protocol}//${url.host}`;
      path = url.pathname;
    } catch {
      return '';
    }
  }
  const segments = path
    .replace(/[?#;].*$/su, '')
    .split('/')
    .map((segment) => (looksLikeToken(segment) ? '[token]' : segment));
  return truncateGraphemes(scrubPersonalData(`${host}${segments.join('/')}`), 200);
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
 * parses to exactly the original values. U+2028, U+2029 and look-alike angle brackets (the
 * fullwidth `＜`, `〈` and their kin) are escaped too.
 */
export function encodeDataBlock(tag: DataTag, data: unknown): string {
  const json = JSON.stringify(data, null, 1)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    // Line separators and look-alike angle brackets, which a model might read as a tag.
    .replace(
      /[\u2028\u2029＜＞﹤﹥〈〉〈〉⟨⟩‹›]/gu,
      (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
    );
  return `<${tag}>\n${json}\n</${tag}>`;
}

const INSTRUCTION_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  {
    id: 'override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|these|those|the|your)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules|directions|guidelines)\b/iu,
  },
  { id: 'persona', pattern: /\byou are now\b/iu },
  {
    id: 'system-prompt',
    pattern: /\b(?:system|developer)[ \t]{1,5}(?:prompt|message|instructions?)\b/iu,
  },
  { id: 'role-label', pattern: /^[ \t]{0,20}(?:system|assistant|user|human|ai)[ \t]{0,5}:/imu },
  {
    id: 'markup',
    pattern:
      /<\/?[ \t]{0,5}(?:system|assistant|user|human|instructions?|merchant_data|rendered_element|candidates|theme_source|rule|alt_text_under_review)\b[^>]{0,200}>/iu,
  },
  { id: 'new-instructions', pattern: /\bnew[ \t]{1,5}instructions?\b/iu },
];

/**
 * Heuristic signals that text is trying to instruct a model, looked for in the same
 * normalized form the model receives (invisible characters removed, NFKC). A signal never
 * blocks a call by itself (the architecture is the defence); it marks the result for review
 * so that bulk approval skips it, and a model output carrying one is rejected.
 */
export function detectInstructionLikeText(text: string): string[] {
  const normalized = sanitizeUntrustedText(text, 1_000_000);
  return INSTRUCTION_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ id }) => id);
}
