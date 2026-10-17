// The guards of the interactive-state scripts (PLAN §11, step 5): checkout is never entered,
// no form with personal data is ever submitted, and nothing navigates off the store or into a
// new window. Pure functions over descriptions the probe returns and requests the network
// layer sees, so they are unit-tested without a browser. Method: ADR-116.
//
// Every check here is linear in its input: URLs and bodies come from the page.
import type { ControlDescription, FieldDescription, GuardVerdict } from '../browser/protocol.ts';

type Guard = 'checkout' | 'personal_data' | 'navigation';

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Decodes percent-encoding up to three times (`%2563` → `%63` → `c`), leaving bad escapes. */
function decode(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    if (!current.includes('%')) break;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      next = current.replace(/%[0-9a-f]{2}/gi, (escape) => {
        try {
          return decodeURIComponent(escape);
        } catch {
          return escape;
        }
      });
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

function segmentsOf(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decode(s).toLowerCase());
}

const CART_CHECKOUT_KEYS = new Set(['checkout', 'return_to']);

function isCartPath(segments: readonly string[]): boolean {
  return segments.includes('cart') || segments.some((s) => s === 'cart.js');
}

/** Whether a parameter value is itself a URL into checkout (`?redirect=/checkout`). */
function valueLeadsToCheckout(value: string, base: URL, depth: number): boolean {
  const v = decode(value).trim();
  if (v === '' || v.length > 2_048) return false;
  if (!v.startsWith('/') && !/^https?:/i.test(v)) return false;
  return isCheckoutUrlAt(v, base.href, depth + 1);
}

function isCheckoutUrlAt(url: string, base: string | undefined, depth: number): boolean {
  const parsed = parse(url, base);
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return false;
  }
  const segments = segmentsOf(parsed);
  if (segments.some((s) => s === 'checkout' || s === 'checkouts')) return true;
  const cartAt = segments.indexOf('cart');
  const next = cartAt === -1 ? undefined : segments[cartAt + 1];
  if (next !== undefined && /^\d+:\d+/.test(next)) return true;
  const cart = isCartPath(segments);
  if (depth > 2) return false;
  for (const [rawKey, value] of parsed.searchParams) {
    const key = decode(rawKey).toLowerCase();
    if (cart && CART_CHECKOUT_KEYS.has(key)) return true;
    if (valueLeadsToCheckout(value, parsed, depth)) return true;
  }
  return false;
}

/**
 * Whether `url` leads into checkout: any `checkout` or `checkouts` path segment after
 * percent-decoding (Shopify's `/checkouts/...`, `/cart/checkout`, Shop Pay's
 * `/checkout?payment=shop_pay`), a cart permalink (`/cart/<variant>:<quantity>`), a cart URL
 * with a `checkout` or `return_to` parameter, or any parameter whose value is such a URL.
 */
export function isCheckoutUrl(url: string, base?: string): boolean {
  return isCheckoutUrlAt(url, base, 0);
}

/** Longest request body read; a longer body to the store is refused, not skimmed. */
const BODY_LIMIT = 65_536;

interface BodyField {
  readonly key: string;
  readonly value: string;
}

function flattenJson(value: unknown, prefix: string, out: BodyField[], depth: number): void {
  if (out.length > 1_000 || depth > 8) return;
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenJson(v, prefix === '' ? k : `${prefix}.${k}`, out, depth + 1);
    }
    return;
  }
  out.push({ key: prefix, value: typeof value === 'string' ? value : JSON.stringify(value) });
}

/** Fields of a urlencoded, multipart or JSON body, keys decoded and lower-cased. */
function bodyFields(body: string): BodyField[] {
  const out: BodyField[] = [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      flattenJson(JSON.parse(body) as unknown, '', out, 0);
    } catch {
      out.push({ key: '', value: body });
    }
  } else if (body.includes('Content-Disposition')) {
    let at = body.indexOf('name="');
    while (at !== -1 && out.length <= 1_000) {
      const end = body.indexOf('"', at + 6);
      if (end === -1) break;
      const key = body.slice(at + 6, end);
      const start = body.indexOf('\r\n\r\n', end);
      const stop = start === -1 ? -1 : body.indexOf('\r\n--', start + 4);
      const value = start === -1 ? '' : body.slice(start + 4, stop === -1 ? undefined : stop);
      out.push({ key, value });
      at = body.indexOf('name="', stop === -1 ? end : stop);
    }
  } else {
    for (const [key, value] of new URLSearchParams(body)) {
      if (out.length > 1_000) break;
      out.push({ key, value });
    }
  }
  return out.map((f) => ({ key: decode(f.key).toLowerCase(), value: f.value }));
}

/** Whether a request would enter checkout, including a cart post asking for it. */
export function isCheckoutRequest(method: string, url: string, body: string | null): boolean {
  if (isCheckoutUrl(url)) return true;
  if (method.toUpperCase() === 'GET' || body === null) return false;
  const parsed = parse(url);
  if (parsed === null || !isCartPath(segmentsOf(parsed))) return false;
  const fields = bodyFields(body.slice(0, BODY_LIMIT));
  return fields.some(
    (f) =>
      CART_CHECKOUT_KEYS.has(f.key) ||
      f.key.endsWith('.return_to') ||
      valueLeadsToCheckout(f.value, parsed, 0),
  );
}

/** Whether `url` is the cart add endpoint (`/cart/add`, `/cart/add.js`, any locale prefix). */
export function isCartAddUrl(url: string, base?: string): boolean {
  const parsed = parse(url, base);
  if (parsed === null) return false;
  const segments = segmentsOf(parsed);
  const last = segments[segments.length - 1];
  return segments[segments.length - 2] === 'cart' && (last === 'add' || last === 'add.js');
}

// HTML autofill field names that hold personal data:
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
const PERSONAL_AUTOCOMPLETE =
  /^(?:name|honorific-prefix|given-name|additional-name|family-name|honorific-suffix|nickname|username|new-password|current-password|one-time-code|organization-title|organization|street-address|address-line[123]|address-level[1-4]|country|country-name|postal-code|cc-.+|bday(?:-day|-month|-year)?|sex|tel(?:-.+)?|email|impp|photo|url)$/;
const PERSONAL_NAME =
  /e-?mail|phone|mobile|\btel\b|telephone|first[_\s-]?name|last[_\s-]?name|full[_\s-]?name|(?:^|[^a-z])name(?:[^a-z]|$)|address|street|city|zip|postal|post[_\s-]?code|birth|password|card|cvv|cvc|ssn|recipient/i;
// Fields a storefront add-to-cart form carries; never personal data.
const CART_FIELDS = new Set([
  'id',
  'quantity',
  'form_type',
  'utf8',
  'product-id',
  'section-id',
  'sections',
  'sections_url',
  'selling_plan',
]);
const CHOICE_TYPES = new Set(['radio', 'checkbox']);
const NEVER_SUBMITTED = new Set(['button', 'fieldset', 'output']);
const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);

function looksPersonal(name: string, autocomplete: string): boolean {
  if (PERSONAL_NAME.test(name)) return true;
  return autocomplete
    .split(/\s+/)
    .filter(Boolean)
    .some((t) => PERSONAL_AUTOCOMPLETE.test(t));
}

/**
 * Whether a form field may be submitted by an interactive-state script. An allow-list: the
 * standard add-to-cart fields, merchant-defined choices (radio buttons, checkboxes and selects
 * not named or autofilled like personal data) and controls that submit nothing of their own.
 * Every other field, including any form-associated custom element, is refused.
 */
export function isAllowedCartField(field: FieldDescription): boolean {
  if (field.tag.includes('-')) return false;
  if (NEVER_SUBMITTED.has(field.tag)) return true;
  if (field.tag === 'input' && BUTTON_TYPES.has(field.type)) return true;
  if (
    field.tag === 'input' &&
    CART_FIELDS.has(field.name) &&
    !looksPersonal(field.name, field.autocomplete)
  ) {
    return (
      field.type === 'hidden' ||
      field.type === 'number' ||
      field.type === '' ||
      field.type === 'text'
    );
  }
  const choice = (field.tag === 'input' && CHOICE_TYPES.has(field.type)) || field.tag === 'select';
  return choice && !looksPersonal(field.name, field.autocomplete) && !looksPersonal(field.id, '');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function readField(value: unknown): FieldDescription | null {
  if (!isRecord(value)) return null;
  const { tag, type, name, id, autocomplete, hasValue } = value;
  if (![tag, type, name, id, autocomplete].every(isString) || typeof hasValue !== 'boolean') {
    return null;
  }
  return {
    tag: tag as string,
    type: type as string,
    name: name as string,
    id: id as string,
    autocomplete: autocomplete as string,
    hasValue,
  };
}

/**
 * The control description the probe returned, checked field by field, or `null` when it is
 * malformed. The probe runs inside a page that may be hostile, so its output is validated
 * before any guard reads it, and a malformed one is refused.
 */
export function readControlDescription(value: unknown): ControlDescription | null {
  if (!isRecord(value)) return null;
  const {
    tag,
    type,
    name,
    href,
    formAction,
    formMethod,
    target,
    inPaymentWidget,
    fields,
    pageUrl,
  } = value;
  if (![tag, type, name, target, pageUrl].every(isString)) return null;
  if (![href, formAction, formMethod].every(isStringOrNull)) return null;
  if (typeof inPaymentWidget !== 'boolean' || !Array.isArray(fields) || fields.length > 1_000) {
    return null;
  }
  const read = fields.map(readField);
  if (read.some((f) => f === null)) return null;
  return {
    tag: tag as string,
    type: type as string,
    name: name as string,
    href: href as string | null,
    formAction: formAction as string | null,
    formMethod: formMethod as string | null,
    target: target as string,
    inPaymentWidget,
    fields: read.filter((f): f is FieldDescription => f !== null),
    pageUrl: pageUrl as string,
  };
}

function documentOf(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`;
}

function refuse(guard: Guard, detail: string): GuardVerdict {
  return { safe: false, guard, detail };
}

/** Whether activating the described control is safe for an interactive-state script. */
export function guardControl(control: ControlDescription): GuardVerdict {
  const page = parse(control.pageUrl);
  if (page === null) return refuse('navigation', 'page URL unreadable');
  if (control.inPaymentWidget) return refuse('checkout', 'accelerated checkout button');
  if (control.name.toLowerCase() === 'checkout')
    return refuse('checkout', 'control named checkout');
  const target = control.target.trim().toLowerCase();
  if (target !== '' && target !== '_self') return refuse('navigation', 'opens another window');
  if (control.href !== null) {
    if (isCheckoutUrl(control.href, control.pageUrl))
      return refuse('checkout', 'link into checkout');
    const href = parse(control.href, control.pageUrl);
    if (href === null || (href.protocol !== 'https:' && href.protocol !== 'http:')) {
      return refuse('navigation', 'link is not http(s)');
    }
    if (href.origin !== page.origin) return refuse('navigation', 'link leaves the store');
    if (documentOf(href) !== documentOf(page)) return refuse('navigation', 'link to another page');
  }
  if (control.formAction !== null) {
    if (isCheckoutUrl(control.formAction, control.pageUrl)) {
      return refuse('checkout', 'form posts to checkout');
    }
    const action = parse(control.formAction, control.pageUrl);
    if (action === null || (action.protocol !== 'https:' && action.protocol !== 'http:')) {
      return refuse('navigation', 'form action is not http(s)');
    }
    if (action.origin !== page.origin) return refuse('navigation', 'form posts off the store');
  }
  for (const f of control.fields) {
    if (CART_CHECKOUT_KEYS.has(f.name.toLowerCase())) return refuse('checkout', `field ${f.name}`);
  }
  const refused = control.fields.find((f) => !isAllowedCartField(f));
  if (refused !== undefined) {
    const detail = refused.tag.includes('-')
      ? `custom form control ${refused.tag}`
      : refused.name !== ''
        ? refused.name
        : refused.id !== ''
          ? refused.id
          : refused.type;
    return refuse('personal_data', detail);
  }
  return { safe: true };
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** An email-like token: one `@` with text before it and a dot after it. Linear. */
function hasEmail(value: string): boolean {
  for (const token of value.split(/\s+/)) {
    const at = token.indexOf('@');
    if (at <= 0 || token.includes('@', at + 1)) continue;
    const dot = token.indexOf('.', at + 2);
    if (dot !== -1 && dot < token.length - 1) return true;
  }
  return false;
}

/** A phone-like value: 9+ digits written with separators or a leading `+`. IDs are bare digits. */
function hasPhone(value: string): boolean {
  let digits = 0;
  let separators = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (isDigit(c)) digits += 1;
    else if (' -().+'.includes(value.charAt(i))) separators += 1;
    else return false;
  }
  return digits >= 9 && (separators > 0 || value.startsWith('+'));
}

const CART_ENDPOINTS = new Set([
  'add',
  'add.js',
  'change',
  'change.js',
  'update',
  'update.js',
  'clear',
  'clear.js',
]);

function isCartEndpoint(segments: readonly string[]): boolean {
  const last = segments[segments.length - 1];
  if (last === 'cart' || last === 'cart.js') return true;
  return segments[segments.length - 2] === 'cart' && last !== undefined && CART_ENDPOINTS.has(last);
}

export type Screening =
  | { readonly block: false }
  | { readonly block: true; readonly guard: Guard; readonly detail: string };

/**
 * The network layer's verdict on one request. Checkout is blocked on every origin. A request
 * that sends a body to a store origin is allowed only to a cart endpoint, only when its body
 * fits in 64 KB, and only when no field is named like personal data and no value looks like
 * an email address or phone number. Other origins are left to the egress proxy (PLAN §18).
 */
export function screenRequest(
  method: string,
  url: string,
  body: string | null,
  stores: ReadonlySet<string>,
): Screening {
  if (isCheckoutRequest(method, url, body)) {
    return { block: true, guard: 'checkout', detail: 'checkout request' };
  }
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return { block: false };
  const parsed = parse(url);
  if (parsed === null || !stores.has(parsed.origin)) return { block: false };
  if (!isCartEndpoint(segmentsOf(parsed))) {
    return { block: true, guard: 'personal_data', detail: 'post to a non-cart endpoint' };
  }
  if (body === null) return { block: false };
  if (body.length > BODY_LIMIT) {
    return { block: true, guard: 'personal_data', detail: 'body too large to screen' };
  }
  for (const f of bodyFields(body)) {
    if (looksPersonal(f.key, '')) return { block: true, guard: 'personal_data', detail: f.key };
    if (hasEmail(f.value) || hasPhone(f.value.trim())) {
      return { block: true, guard: 'personal_data', detail: `${f.key} value` };
    }
  }
  return { block: false };
}
