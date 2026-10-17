import { describe, expect, it } from 'vitest';
import type { ControlDescription, FieldDescription } from '../src/browser/protocol.ts';
import {
  guardControl,
  isAllowedCartField,
  isCartAddUrl,
  isCheckoutRequest,
  isCheckoutUrl,
  readControlDescription,
  screenRequest,
} from '../src/states/guards.ts';

const ORIGIN = 'https://shop.example.test';
const PAGE = `${ORIGIN}/products/linen-dress`;

function field(overrides: Partial<FieldDescription>): FieldDescription {
  return {
    tag: 'input',
    type: 'hidden',
    name: '',
    id: '',
    autocomplete: '',
    hasValue: true,
    ...overrides,
  };
}

function control(overrides: Partial<ControlDescription>): ControlDescription {
  return {
    tag: 'button',
    type: 'submit',
    name: 'add',
    href: null,
    formAction: `${ORIGIN}/cart/add`,
    formMethod: 'post',
    target: '',
    inPaymentWidget: false,
    fields: [field({ name: 'id' }), field({ name: 'quantity', type: 'number' })],
    pageUrl: PAGE,
    ...overrides,
  };
}

describe('isCheckoutUrl', () => {
  it('recognises checkout paths, cart permalinks and cart checkout', () => {
    for (const url of [
      '/checkout',
      '/checkouts/cn/abc123',
      '/12345/checkouts/abc',
      '/en-gb/checkout',
      `${ORIGIN}/CHECKOUT?step=1`,
      '/cart/checkout',
      '/cart/40000000001:1',
      '/cart/40000000001:1,40000000002:2?discount=X',
      '/checkout?payment=shop_pay&source=hydrogen',
      '/cart?checkout',
      '/cart?checkout=1',
    ]) {
      expect(isCheckoutUrl(url, PAGE), url).toBe(true);
    }
  });

  it('decodes percent-encoding before matching (audit L9)', () => {
    expect(isCheckoutUrl(`${ORIGIN}/check%6Fut`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/%63heckouts/cn/x`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/%2563heckout`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/cart?check%6Fut`)).toBe(true);
  });

  it('treats return_to on any cart URL, and a parameter naming checkout, as checkout (audit H1)', () => {
    expect(isCheckoutUrl(`${ORIGIN}/cart/add?id=1&return_to=/checkout`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/cart/change?return_to=/pages/x`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/discount/SAVE?redirect=/checkout`)).toBe(true);
    expect(isCheckoutUrl(`${ORIGIN}/discount/SAVE?redirect=%2Fcheckout`)).toBe(true);
  });

  it('does not flag ordinary storefront URLs or unparsable input', () => {
    for (const url of [
      '/cart',
      '/cart/add',
      '/cart/add.js',
      '/products/checkout-tee-shirt',
      '/pages/checkout-help',
      '/collections/all',
      '/discount/SAVE?redirect=/collections/all',
      '/cart/%E0%A4%A',
    ]) {
      expect(isCheckoutUrl(url, PAGE), url).toBe(false);
    }
    expect(isCheckoutUrl('http://[::1', 'not a url')).toBe(false);
  });
});

describe('isCheckoutRequest', () => {
  it('treats a cart post that asks for checkout as checkout, in any body format', () => {
    for (const [url, body] of [
      [`${ORIGIN}/cart`, 'updates%5B%5D=1&checkout='],
      [`${ORIGIN}/cart`, 'checkout'],
      [`${ORIGIN}/cart`, 'check%6Fut=1'],
      [`${ORIGIN}/cart/update`, 'updates%5B%5D=1&checkout='],
      [`${ORIGIN}/cart/add`, 'id=1&quantity=1&return_to=%2Fcheckout'],
      [`${ORIGIN}/cart/add.js`, '{"items":[{"id":1}],"return_to":"/checkout"}'],
      [
        `${ORIGIN}/cart`,
        '------x\r\nContent-Disposition: form-data; name="checkout"\r\n\r\n\r\n------x--',
      ],
      [
        `${ORIGIN}/cart/add`,
        '------x\r\nContent-Disposition: form-data; name="return_to"\r\n\r\n/checkout\r\n------x--',
      ],
    ] as const) {
      expect(isCheckoutRequest('POST', url, body), `${url} ${body}`).toBe(true);
    }
  });

  it('lets add-to-cart and ordinary cart posts through', () => {
    expect(isCheckoutRequest('POST', `${ORIGIN}/cart/add.js`, 'id=1&quantity=1')).toBe(false);
    expect(isCheckoutRequest('POST', `${ORIGIN}/cart`, 'updates%5B%5D=2')).toBe(false);
    expect(isCheckoutRequest('GET', `${ORIGIN}/cart`, null)).toBe(false);
  });
});

describe('isCartAddUrl', () => {
  it('matches the cart add endpoint with or without a locale prefix', () => {
    expect(isCartAddUrl('/cart/add', PAGE)).toBe(true);
    expect(isCartAddUrl('/fr/cart/add.js', PAGE)).toBe(true);
    expect(isCartAddUrl('/cart', PAGE)).toBe(false);
    expect(isCartAddUrl('/checkout', PAGE)).toBe(false);
  });
});

describe('isAllowedCartField (an allow-list, audit M4)', () => {
  it('allows the fields of an add-to-cart form and merchant-defined choices', () => {
    for (const f of [
      field({ name: 'id' }),
      field({ name: 'form_type' }),
      field({ name: 'utf8' }),
      field({ name: 'product-id' }),
      field({ name: 'section-id' }),
      field({ name: 'sections' }),
      field({ name: 'sections_url' }),
      field({ name: 'selling_plan' }),
      field({ type: 'number', name: 'quantity' }),
      field({ type: 'radio', name: 'Size-1' }),
      field({ type: 'checkbox', name: 'options[Gift wrap]' }),
      field({ tag: 'select', type: '', name: 'options[Colour]' }),
      field({ tag: 'button', type: 'submit', name: 'add' }),
      field({ tag: 'fieldset', type: '', name: '' }),
    ]) {
      expect(isAllowedCartField(f), JSON.stringify(f)).toBe(true);
    }
  });

  it('refuses everything else, whatever its name', () => {
    for (const f of [
      field({ type: 'email', name: 'contact' }),
      field({ type: 'text', name: 'properties[Engraving]', hasValue: false }),
      field({ type: 'hidden', name: 'properties[_bundle]' }),
      field({ type: 'hidden', name: 'note' }),
      field({ tag: 'textarea', type: '', name: 'properties[Message]' }),
      field({ type: 'radio', name: 'address_id' }),
      field({ tag: 'select', type: '', name: 'x', autocomplete: 'shipping country' }),
      field({ tag: 'gift-email', type: '', name: 'recipient' }),
      field({ tag: 'object', type: '', name: 'x' }),
      field({ type: 'file', name: 'upload' }),
    ]) {
      expect(isAllowedCartField(f), JSON.stringify(f)).toBe(false);
    }
  });
});

describe('guardControl', () => {
  it('allows a plain add-to-cart button and a same-page toggle', () => {
    expect(guardControl(control({}))).toEqual({ safe: true });
    expect(
      guardControl(
        control({ tag: 'a', type: '', href: `${PAGE}#menu`, formAction: null, fields: [] }),
      ),
    ).toEqual({ safe: true });
  });

  it('refuses anything that could enter checkout', () => {
    for (const c of [
      control({ name: 'checkout' }),
      control({ inPaymentWidget: true }),
      control({ formAction: `${ORIGIN}/checkout` }),
      control({ formAction: `${ORIGIN}/cart/add?return_to=/checkout` }),
      control({ fields: [field({ name: 'id' }), field({ name: 'return_to' })] }),
      control({ tag: 'a', href: `${ORIGIN}/checkouts/cn/1`, formAction: null, fields: [] }),
    ]) {
      expect(guardControl(c), JSON.stringify(c)).toMatchObject({ safe: false, guard: 'checkout' });
    }
  });

  it('refuses off-store, non-HTTP, other-page and new-window targets (audit M5, L8)', () => {
    for (const c of [
      control({ tag: 'a', type: '', href: 'https://evil.example/', formAction: null, fields: [] }),
      control({
        tag: 'a',
        type: '',
        href: "javascript:window.open('/check'+'outs/x')",
        formAction: null,
        fields: [],
      }),
      control({ tag: 'a', type: '', href: 'https://pay.shopify.com/pay/1', formAction: null }),
      control({ tag: 'a', type: '', href: `${ORIGIN}/collections/all`, formAction: null }),
      control({ formAction: 'https://evil.example/cart/add' }),
      control({ formAction: 'data:text/html,x' }),
      control({ target: '_blank' }),
      control({ target: 'popup' }),
    ]) {
      expect(guardControl(c), JSON.stringify(c)).toMatchObject({
        safe: false,
        guard: 'navigation',
      });
    }
    expect(guardControl(control({ target: '_self' }))).toEqual({ safe: true });
  });

  it('refuses a form with any field outside the allow-list, naming the field, not its value', () => {
    expect(
      guardControl(
        control({
          fields: [field({ name: 'id' }), field({ type: 'email', name: 'contact[email]' })],
        }),
      ),
    ).toEqual({ safe: false, guard: 'personal_data', detail: 'contact[email]' });
    expect(
      guardControl(control({ fields: [field({ name: 'id' }), field({ tag: 'gift-email' })] })),
    ).toEqual({ safe: false, guard: 'personal_data', detail: 'custom form control gift-email' });
  });
});

describe('readControlDescription (the page boundary)', () => {
  it('accepts a well-formed description', () => {
    const c = control({});
    expect(readControlDescription(JSON.parse(JSON.stringify(c)) as unknown)).toEqual(c);
  });

  it('rejects anything malformed, as a page could return', () => {
    const withoutTarget: Record<string, unknown> = { ...control({}) };
    delete withoutTarget['target'];
    for (const value of [
      null,
      'x',
      withoutTarget,
      { ...control({}), href: 3 },
      { ...control({}), fields: 'id' },
      { ...control({}), fields: [{ ...field({}), name: null }] },
      { ...control({}), inPaymentWidget: 'no' },
    ] as unknown[]) {
      expect(readControlDescription(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('screenRequest (the network layer)', () => {
  const stores = new Set([ORIGIN]);

  it('blocks checkout requests on any origin', () => {
    expect(screenRequest('GET', `${ORIGIN}/checkouts/cn/1`, null, stores)).toMatchObject({
      block: true,
      guard: 'checkout',
    });
  });

  it('allows posts only to the cart endpoints of the store', () => {
    expect(screenRequest('POST', `${ORIGIN}/cart/add.js`, 'id=1&quantity=1', stores)).toEqual({
      block: false,
    });
    expect(screenRequest('POST', `${ORIGIN}/fr/cart/change.js`, '{"line":1}', stores)).toEqual({
      block: false,
    });
    expect(screenRequest('POST', `${ORIGIN}/contact`, 'form_type=contact', stores)).toMatchObject({
      block: true,
      guard: 'personal_data',
    });
    expect(screenRequest('POST', `${ORIGIN}/account/login`, 'x=1', stores)).toMatchObject({
      block: true,
    });
  });

  it('blocks cart posts that carry personal data in a key or a value', () => {
    for (const body of [
      'id=1&properties%5BRecipient+email%5D=someone%40example.test',
      'id=1&properties%5BNote%5D=someone%40example.test',
      'id=1&properties%5BNote%5D=%2B1+555+010+0199',
      '{"id":1,"properties":{"Email":"x"}}',
    ]) {
      expect(screenRequest('POST', `${ORIGIN}/cart/add.js`, body, stores), body).toMatchObject({
        block: true,
        guard: 'personal_data',
      });
    }
  });

  it('leaves other origins to the egress proxy and reads only bounded bodies', () => {
    expect(screenRequest('POST', 'https://cdn.example.test/x', 'email=a@b.co', stores)).toEqual({
      block: false,
    });
    expect(
      screenRequest('POST', `${ORIGIN}/cart/add.js`, `id=1&x=${'a'.repeat(70_000)}`, stores),
    ).toMatchObject({ block: true, guard: 'personal_data' });
  });
});
