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
// C0 and C1 controls except tab and line feed, and the bidirectional overrides and isolates
// that can make text read differently from how it is stored.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/gu;
// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

function clean(value: string): string {
  return value.replaceAll('\r\n', '\n').normalize('NFC').replaceAll(UNSAFE, '').trim();
}

function samePath(value: string): string | null {
  const path = value.trim();
  const ok =
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('/\\') &&
    path.length <= MAX_PAGE_LENGTH &&
    !CONTROL.test(path);
  return ok ? path : null;
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
  const locale = first('locale').trim();
  return {
    kind: 'accepted',
    report: {
      description,
      email: email === '' ? null : email,
      page: samePath(first('page')),
      pageType: PAGE_TYPES.has(pageType) ? pageType : null,
      locale: locale.length <= 35 && LOCALE.test(locale) ? locale : null,
    },
  };
}
