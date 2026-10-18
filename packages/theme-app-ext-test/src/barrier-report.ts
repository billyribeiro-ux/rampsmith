// Barrier-report body rules for the app proxy endpoint (ADR-162). The api implements these in
// Rust; this module is the reference the browser tests' fake app proxy runs, so the form and
// the contract are tested together. Bodies are application/x-www-form-urlencoded, the same
// encoding a plain form post and the deferred script both send.

/**
 * Bytes of request body read at most; larger bodies are refused before parsing. A maximal
 * report in a non-Latin script percent-encodes to about 25 KB (2000 characters at up to 9
 * bytes each, plus the path), so the limit sits above that.
 */
export const MAX_BODY_BYTES = 32_768;
/** Matches the form's maxlength, which browsers count in UTF-16 code units. */
export const MAX_DESCRIPTION_LENGTH = 2000;
/** RFC 5321's path limit, which the form's maxlength repeats. */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PAGE_LENGTH = 2048;
/** A form sent this soon after the page loaded was not typed by a person. */
export const MIN_ELAPSED_MS = 3000;

/** `request.page_type` values (shopify.dev/docs/api/liquid/objects/request, 17 Oct 2026). */
export const PAGE_TYPES: ReadonlySet<string> = new Set([
  '404',
  'article',
  'blog',
  'captcha',
  'cart',
  'collection',
  'list-collections',
  'customers/account',
  'customers/activate_account',
  'customers/addresses',
  'customers/login',
  'customers/order',
  'customers/register',
  'customers/reset_password',
  'gift_card',
  'index',
  'metaobject',
  'page',
  'password',
  'policy',
  'product',
  'search',
]);

export interface BarrierReport {
  readonly description: string;
  readonly email: string | null;
  readonly page: string | null;
  readonly pageType: string | null;
  readonly locale: string | null;
}

interface FieldError {
  readonly field: 'description' | 'email';
  readonly code: 'missing' | 'too-long' | 'invalid';
}

export type ParseResult =
  | { readonly kind: 'accepted'; readonly report: BarrierReport }
  | { readonly kind: 'invalid'; readonly errors: readonly FieldError[] }
  | { readonly kind: 'discarded'; readonly reason: 'honeypot' | 'too-fast' }
  | { readonly kind: 'too-large' };

// The WHATWG "valid email address" production, which <input type="email"> enforces.
const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/u;
const LOCALE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8}){0,4}$/u;
// Removed from submitted text: C0 and C1 controls except tab and line feed; the bidirectional
// overrides and isolates (U+202A-U+202E, U+2066-U+2069) that make text read differently from
// how it is stored; and the invisible zero-width space, word joiner and byte-order mark. Line
// and paragraph separators become line feeds. Zero-width (non-)joiners and the directional
// marks stay: scripts such as Persian, Hindi and Arabic need them.
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{200B}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}]/gu;
// A page path is refused outright if it holds any of those, any whitespace, the Arabic letter
// mark or the Hangul fillers (invisible characters used to disguise paths).
const PATH_UNSAFE =
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u{061C}\u{115F}\u{1160}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{3164}\u{FEFF}\u{FFA0}\s]/u;

/**
 * Page types whose path is worth keeping. Every other type (customer account pages, gift
 * cards, the storefront password and challenge pages) can carry identifiers or secrets in
 * its path, so only its type is kept.
 */
export const PUBLIC_PAGE_TYPES: ReadonlySet<string> = new Set([
  '404',
  'article',
  'blog',
  'cart',
  'collection',
  'index',
  'list-collections',
  'metaobject',
  'page',
  'policy',
  'product',
  'search',
]);

function clean(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll(/[\u{2028}\u{2029}]/gu, '\n')
    .replaceAll(UNSAFE, '')
    .normalize('NFC')
    .trim();
}

/** A same-site path, never one on an app proxy (whose paths other apps may use for tokens). */
function samePath(value: string): string | null {
  const path = value.trim();
  const ok =
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('/\\') &&
    path.length <= MAX_PAGE_LENGTH &&
    !PATH_UNSAFE.test(path) &&
    !/^\/(?:a|apps|community|tools)\//u.test(path);
  return ok ? path : null;
}

/**
 * One CSV cell of the merchant's export: always quoted, and a leading character a spreadsheet
 * would read as a formula (`= + - @`, their full-width forms, tab or carriage return) is
 * prefixed with an apostrophe, also behind leading whitespace, because every report is text
 * from an anonymous visitor.
 */
export function exportCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^\s*[=+\-@\t\r\u{FF1D}\u{FF0B}\u{FF0D}\u{FF20}]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * Parses and validates a barrier-report body. A filled honeypot or a too-fast submission is
 * "discarded": the endpoint answers exactly as for an accepted report and stores nothing, so
 * a bot learns nothing. `logged_in_customer_id` and every other field are ignored.
 */
export function parseBarrierReport(body: string): ParseResult {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { kind: 'too-large' };
  const fields = new URLSearchParams(body);
  const first = (name: string): string => fields.get(name) ?? '';

  if (first('website').trim() !== '') return { kind: 'discarded', reason: 'honeypot' };
  const elapsed = first('elapsed_ms');
  if (/^[0-9]{1,9}$/u.test(elapsed) && Number(elapsed) < MIN_ELAPSED_MS) {
    return { kind: 'discarded', reason: 'too-fast' };
  }

  const errors: FieldError[] = [];
  const description = clean(first('description'));
  if (description === '') errors.push({ field: 'description', code: 'missing' });
  else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({ field: 'description', code: 'too-long' });
  }
  const email = first('email').trim();
  if (email !== '' && (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email))) {
    errors.push({ field: 'email', code: 'invalid' });
  }
  if (errors.length > 0) return { kind: 'invalid', errors };

  const pageType = first('page_type').trim();
  const known = PAGE_TYPES.has(pageType);
  const locale = first('locale').trim();
  return {
    kind: 'accepted',
    report: {
      description,
      email: email === '' ? null : email,
      page: known && PUBLIC_PAGE_TYPES.has(pageType) ? samePath(first('page')) : null,
      pageType: known ? pageType : null,
      locale: locale.length <= 35 && LOCALE.test(locale) ? locale : null,
    },
  };
}

/** Digits a phone number must have before the compliance search compares it at all. */
export const MIN_PHONE_DIGITS = 7;

/**
 * Whether a report's description mentions the shopper a compliance webhook names, for reports
 * submitted without the email field. The email is compared as a literal, case-insensitive
 * substring, never as a LIKE pattern, whose `_` and `%` would match other shoppers' addresses.
 * Phone numbers are compared as digits only: a run of digits in the description matches when
 * one ends with the other and the shorter has at least MIN_PHONE_DIGITS, so "+1 613 555 0100"
 * finds "(613) 555-0100".
 */
export function mentionsShopper(
  description: string,
  shopper: { readonly email?: string | null; readonly phone?: string | null },
): boolean {
  const text = description.toLowerCase();
  const email = (shopper.email ?? '').trim().toLowerCase();
  if (email !== '' && text.includes(email)) return true;
  const phone = (shopper.phone ?? '').replaceAll(/[^0-9]/gu, '');
  if (phone.length < MIN_PHONE_DIGITS) return false;
  for (const run of description.match(/\+?[0-9][0-9 ().-]*[0-9]/gu) ?? []) {
    const digits = run.replaceAll(/[^0-9]/gu, '');
    const shorter = Math.min(digits.length, phone.length);
    if (shorter >= MIN_PHONE_DIGITS && (digits.endsWith(phone) || phone.endsWith(digits))) {
      return true;
    }
  }
  return false;
}
