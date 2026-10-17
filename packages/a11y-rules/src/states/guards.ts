// The two guards of the interactive-state scripts (PLAN §11, step 5): checkout is never
// entered and no form with personal data is ever submitted. Pure functions over descriptions
// the probe returns, so they are unit-tested without a browser. Method: ADR-116.
import type { ControlDescription, FieldDescription, GuardVerdict } from '../browser/protocol.ts';

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/**
 * Whether `url` leads into checkout: any `checkout` or `checkouts` path segment (Shopify's
 * `/checkouts/...`, `/cart/checkout`, Shop Pay's `/checkout/...`), a cart permalink
 * (`/cart/<variant>:<quantity>`, which goes to checkout) or a cart URL with a `checkout`
 * parameter.
 */
export function isCheckoutUrl(url: string, base?: string): boolean {
  const parsed = parse(url, base);
  if (parsed === null) return false;
  const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.some((s) => s === 'checkout' || s === 'checkouts')) return true;
  const cartAt = segments.indexOf('cart');
  if (cartAt === -1) return false;
  const next = segments[cartAt + 1];
  if (next !== undefined && /^\d+:\d+/.test(next)) return true;
  return next === undefined && parsed.searchParams.has('checkout');
}

/** Whether a request would enter checkout, including a cart form posted with `checkout`. */
export function isCheckoutRequest(method: string, url: string, body: string | null): boolean {
  if (isCheckoutUrl(url)) return true;
  if (method.toUpperCase() !== 'POST' || body === null) return false;
  const parsed = parse(url);
  if (parsed === null || !/(?:^|\/)cart\/?$/i.test(parsed.pathname)) return false;
  return /(?:^|&)checkout(?:=|&|$)/.test(body) || body.includes('name="checkout"');
}

/** Whether `url` is the cart add endpoint (`/cart/add`, `/cart/add.js`, any locale prefix). */
export function isCartAddUrl(url: string, base?: string): boolean {
  const parsed = parse(url, base);
  return parsed !== null && /\/cart\/add(?:\.js)?$/i.test(parsed.pathname);
}

const PERSONAL_TYPES = new Set(['email', 'tel', 'password']);
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

/** Whether a form field holds or asks for personal data. */
export function isPersonalDataField(field: FieldDescription): boolean {
  if (CART_FIELDS.has(field.name)) return false;
  if (PERSONAL_TYPES.has(field.type)) return true;
  const tokens = field.autocomplete.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => PERSONAL_AUTOCOMPLETE.test(t))) return true;
  if (PERSONAL_NAME.test(field.name) || PERSONAL_NAME.test(field.id)) return true;
  // Free text that already holds a value may be someone's message or name.
  const freeText = field.tag === 'textarea' || (field.tag === 'input' && field.type === 'text');
  return freeText && field.hasValue && field.name.startsWith('properties[');
}

/** Whether activating the described control is safe for an interactive-state script. */
export function guardControl(control: ControlDescription): GuardVerdict {
  if (control.inPaymentWidget) {
    return { safe: false, guard: 'checkout', detail: 'accelerated checkout button' };
  }
  if (control.name.toLowerCase() === 'checkout') {
    return { safe: false, guard: 'checkout', detail: 'control named checkout' };
  }
  if (control.href !== null && isCheckoutUrl(control.href, control.pageUrl)) {
    return { safe: false, guard: 'checkout', detail: 'link into checkout' };
  }
  if (control.formAction !== null && isCheckoutUrl(control.formAction, control.pageUrl)) {
    return { safe: false, guard: 'checkout', detail: 'form posts to checkout' };
  }
  const personal = control.fields.find(isPersonalDataField);
  if (personal !== undefined) {
    return {
      safe: false,
      guard: 'personal_data',
      detail:
        personal.name !== '' ? personal.name : personal.id !== '' ? personal.id : personal.type,
    };
  }
  return { safe: true };
}
