/**
 * Scrubbing before storage (PLAN §18, §19): what the engine writes about a scanned page holds
 * no personal data and no tokens, whatever the page put in its markup or its address.
 *
 * - HTML excerpts lose form values, email addresses and phone-number patterns, and are cut to
 *   512 characters (`scrubExcerpt`).
 * - Selectors lose attribute values and email addresses (`scrubSelector`): axe names an element
 *   by attributes such as `[href="/account/reset/…?token=…"]` or `[value="jane@example.com"]`.
 * - Page addresses lose credentials, query string, fragment, and path segments that are email
 *   addresses or opaque tokens (`scrubUrl`).
 */
const MAX = 512;
/** Longest scrubbed selector or address kept. */
const MAX_TEXT = 2048;
/** Longest input read; hostile pages can make axe produce very long selectors. */
const MAX_INPUT = 4096;

export function scrubExcerpt(html: string): string {
  return redactEmails(html.slice(0, MAX_INPUT))
    .replaceAll(/\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' value=""')
    .replaceAll(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .slice(0, MAX);
}

/** C0 and C1 control characters, which PostgreSQL text cannot hold (NUL) or should not. */
const CONTROL = /\p{Cc}/gu;

const LOCAL_CHAR = /[\w+.\\-]/;
const DOMAIN_CHAR = /[\w.\\-]/;

/**
 * Replaces email addresses with `[email]`, written plainly or with CSS escapes
 * (`jane\.doe\@example\.com`, as an id selector spells it). A leading dot stays, so
 * `.jane@example.com` keeps its class dot. Linear in the text: it looks outward from each `@`
 * instead of backtracking through a pattern, because the text is hostile.
 */
function redactEmails(text: string): string {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf('@', from);
    if (at === -1) break;
    from = at + 1;
    let start = at;
    while (start > copied && LOCAL_CHAR.test(text.charAt(start - 1))) start -= 1;
    while (start < at && text.charAt(start) === '.') start += 1;
    let end = at + 1;
    while (end < text.length && DOMAIN_CHAR.test(text.charAt(end))) end += 1;
    if (/\w/.test(text.slice(start, at)) && /\w(?:\.|\\\.)\w/.test(text.slice(at + 1, end))) {
      out += `${text.slice(copied, start)}[email]`;
      copied = end;
      from = end;
    }
  }
  return out + text.slice(copied);
}

/**
 * Attributes whose value describes structure rather than content, so keeping it tells two
 * elements apart without storing anything a shopper typed or a merchant wrote.
 */
const STRUCTURAL_ATTRIBUTES = new Set([
  'type',
  'role',
  'rel',
  'target',
  'name',
  'tabindex',
  'dir',
  'aria-hidden',
  'aria-expanded',
  'aria-haspopup',
  'aria-checked',
  'aria-selected',
  'aria-pressed',
  'aria-current',
  'aria-disabled',
  'aria-required',
  'aria-invalid',
  'aria-modal',
  'aria-live',
  'aria-orientation',
  'aria-sort',
  'aria-autocomplete',
  'aria-readonly',
  'aria-busy',
]);
/** A short value made of word characters, dots, colons, hyphens and brackets (`contact[email]`). */
const STRUCTURAL_VALUE = /^[\w.:[\]-]{0,64}$/;

const WHITESPACE = /\s/;
const OPERATOR_START = new Set(['~', '|', '^', '$', '*']);

interface Parsed {
  readonly end: number;
  readonly text: string;
}

/** Reads a name or bare value up to a character `stop` accepts, honouring `\` escapes. */
function readRun(s: string, from: number, stop: (c: string) => boolean): number {
  let i = from;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '\\') {
      i += 2;
    } else if (stop(c)) {
      break;
    } else {
      i += 1;
    }
  }
  return Math.min(i, s.length);
}

function skipSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && WHITESPACE.test(s.charAt(i))) i += 1;
  return i;
}

/**
 * Parses the attribute selector that starts at `s[start] === '['` and returns its scrubbed
 * form, or undefined when it is malformed (so nothing after it can be trusted).
 */
function scrubAttribute(s: string, start: number): Parsed | undefined {
  let i = skipSpace(s, start + 1);
  const nameEnd = readRun(
    s,
    i,
    (c) => WHITESPACE.test(c) || c === ']' || c === '=' || OPERATOR_START.has(c),
  );
  const name = s.slice(i, nameEnd);
  i = skipSpace(s, nameEnd);
  if (s.charAt(i) === ']') return { end: i + 1, text: `[${name}]` };

  let operator = '=';
  if (OPERATOR_START.has(s.charAt(i))) {
    operator = `${s.charAt(i)}=`;
    i += 1;
  }
  if (s.charAt(i) !== '=') return undefined;
  i = skipSpace(s, i + 1);

  let value: string;
  const quote = s.charAt(i);
  if (quote === '"' || quote === "'") {
    const close = readRun(s, i + 1, (c) => c === quote);
    if (s.charAt(close) !== quote) return undefined;
    value = s.slice(i + 1, close);
    i = close + 1;
  } else {
    const close = readRun(s, i, (c) => WHITESPACE.test(c) || c === ']');
    value = s.slice(i, close);
    i = close;
  }
  i = skipSpace(s, i);
  let flag = '';
  const maybeFlag = s.charAt(i).toLowerCase();
  if ((maybeFlag === 'i' || maybeFlag === 's') && /[\s\]]/.test(s.charAt(i + 1))) {
    flag = ` ${maybeFlag}`;
    i = skipSpace(s, i + 1);
  }
  if (s.charAt(i) !== ']') return undefined;

  const keep = STRUCTURAL_ATTRIBUTES.has(name.toLowerCase()) && STRUCTURAL_VALUE.test(value);
  return { end: i + 1, text: keep ? `[${name}${operator}"${value}"${flag}]` : `[${name}]` };
}

/**
 * The selector without attribute values (except structural ones) and without email addresses.
 * Axe joins the parts of a selector that crosses a frame or shadow root with ` >>> `; the
 * scrub works on the joined text.
 */
export function scrubSelector(selector: string): string {
  const input = selector.replaceAll(CONTROL, '').slice(0, MAX_INPUT);
  let out = '';
  let i = 0;
  while (i < input.length) {
    const c = input.charAt(i);
    if (c === '\\') {
      out += input.slice(i, i + 2);
      i += 2;
    } else if (c === '[') {
      const parsed = scrubAttribute(input, i);
      if (parsed === undefined) {
        // Malformed: nothing after it is trustworthy, so it and the rest are dropped.
        out += '[]';
        break;
      }
      out += parsed.text;
      i = parsed.end;
    } else {
      out += c;
      i += 1;
    }
  }
  return redactEmails(out).slice(0, MAX_TEXT);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 24 or more hexadecimal digits: a digest, a session key, an order-status key. */
const HEX_TOKEN = /^[0-9a-f]{24,}$/i;
/** 22 or more characters of mixed case and digits: a random token. Slugs are lowercase. */
const MIXED_TOKEN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[\w-]{22,}$/;

function scrubSegment(segment: string): string {
  // `;jsessionid=…` style path parameters carry state, never content.
  const bare = segment.split(';', 1)[0] ?? '';
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Not valid percent-encoding: judge the text as it is.
  }
  if (redactEmails(decoded) !== decoded) return '[email]';
  if (UUID.test(decoded) || HEX_TOKEN.test(decoded) || MIXED_TOKEN.test(decoded)) return '[token]';
  return bare;
}

function scrubPath(path: string): string {
  return path
    .split('/')
    .map((segment) => scrubSegment(segment))
    .join('/');
}

/**
 * The page address without credentials, query string, fragment and path parameters, and with
 * email addresses and opaque tokens in the path replaced. Anything that is not an http(s)
 * address (`data:`, `blob:`, `javascript:`) is reduced to its scheme.
 */
export function scrubUrl(address: string): string {
  const input = address.replaceAll(CONTROL, '').slice(0, MAX_INPUT);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return scrubPath(input.split(/[?#]/, 1)[0] ?? '').slice(0, MAX_TEXT);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
  return `${url.protocol}//${url.host}${scrubPath(url.pathname)}`.slice(0, MAX_TEXT);
}
