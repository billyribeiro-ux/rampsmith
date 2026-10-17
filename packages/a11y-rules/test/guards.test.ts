import { describe, expect, it } from 'vitest';
import type { ControlDescription, FieldDescription } from '../src/browser/protocol.ts';
import {
  guardControl,
  isCartAddUrl,
  isCheckoutRequest,
  isCheckoutUrl,
  isPersonalDataField,
} from '../src/states/guards.ts';

const PAGE = 'https://shop.example.test/products/linen-dress';

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
    formAction: 'https://shop.example.test/cart/add',
    formMethod: 'post',
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
      'https://shop.example.test/CHECKOUT?step=1',
      '/cart/checkout',
      '/cart/40000000001:1',
      '/cart/40000000001:1,40000000002:2?discount=X',
      '/cart?checkout',
      '/cart?checkout=1',
    ]) {
      expect(isCheckoutUrl(url, PAGE), url).toBe(true);
    }
  });

  it('accepts ordinary storefront URLs and rejects nothing on unparsable input', () => {
    for (const url of [
      '/cart',
      '/cart/add',
      '/cart/add.js',
      '/products/checkout-tee-shirt',
      '/pages/checkout-help',
      '/collections/all',
    ]) {
      expect(isCheckoutUrl(url, PAGE), url).toBe(false);
    }
    expect(isCheckoutUrl('http://[::1', 'not a url')).toBe(false);
  });
});

describe('isCheckoutRequest', () => {
  it('treats a cart form post that asks for checkout as checkout', () => {
    expect(
      isCheckoutRequest('POST', 'https://shop.example.test/cart', 'updates%5B%5D=1&checkout='),
    ).toBe(true);
    expect(isCheckoutRequest('POST', 'https://shop.example.test/cart', 'checkout')).toBe(true);
    expect(
      isCheckoutRequest(
        'POST',
        'https://shop.example.test/cart',
        '------x\r\nContent-Disposition: form-data; name="checkout"\r\n\r\n\r\n------x--',
      ),
    ).toBe(true);
  });

  it('lets add-to-cart and ordinary cart posts through', () => {
    expect(
      isCheckoutRequest('POST', 'https://shop.example.test/cart/add.js', 'id=1&quantity=1'),
    ).toBe(false);
    expect(isCheckoutRequest('POST', 'https://shop.example.test/cart', 'updates%5B%5D=2')).toBe(
      false,
    );
    expect(isCheckoutRequest('GET', 'https://shop.example.test/cart', null)).toBe(false);
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

describe('isPersonalDataField', () => {
  it('flags personal-data types, autocomplete tokens and names', () => {
    for (const f of [
      field({ type: 'email', name: 'contact' }),
      field({ type: 'tel', name: 'x' }),
      field({ type: 'password', name: 'x' }),
      field({ type: 'text', name: 'x', autocomplete: 'shipping street-address' }),
      field({ type: 'text', name: 'x', autocomplete: 'cc-number' }),
      field({ type: 'text', name: 'properties[Recipient email]' }),
      field({ type: 'text', name: 'properties[Recipient name]' }),
      field({ type: 'text', name: 'customer[first_name]' }),
      field({ type: 'text', name: 'zip' }),
      field({ tag: 'textarea', type: '', name: 'properties[Message]', hasValue: true }),
      field({ type: 'text', name: '', id: 'phone-number' }),
    ]) {
      expect(isPersonalDataField(f), JSON.stringify(f)).toBe(true);
    }
  });

  it('accepts the fields of an add-to-cart form', () => {
    for (const f of [
      field({ name: 'id' }),
      field({ name: 'form_type', hasValue: true }),
      field({ name: 'utf8' }),
      field({ name: 'product-id' }),
      field({ name: 'section-id' }),
      field({ name: 'sections' }),
      field({ name: 'sections_url' }),
      field({ name: 'selling_plan' }),
      field({ type: 'number', name: 'quantity' }),
      field({ type: 'radio', name: 'Size' }),
      field({ tag: 'select', type: '', name: 'options[Colour]' }),
      field({ tag: 'textarea', type: '', name: 'properties[Engraving]', hasValue: false }),
      field({ type: 'text', name: 'x', autocomplete: 'off' }),
    ]) {
      expect(isPersonalDataField(f), JSON.stringify(f)).toBe(false);
    }
  });
});

describe('guardControl', () => {
  it('allows a plain add-to-cart button', () => {
    expect(guardControl(control({}))).toEqual({ safe: true });
  });

  it('refuses anything that could enter checkout', () => {
    expect(guardControl(control({ name: 'checkout' }))).toMatchObject({
      safe: false,
      guard: 'checkout',
    });
    expect(guardControl(control({ inPaymentWidget: true }))).toMatchObject({
      safe: false,
      guard: 'checkout',
    });
    expect(
      guardControl(control({ formAction: 'https://shop.example.test/checkout' })),
    ).toMatchObject({
      safe: false,
      guard: 'checkout',
    });
    expect(
      guardControl(
        control({ tag: 'a', href: 'https://shop.example.test/checkouts/cn/1', formAction: null }),
      ),
    ).toMatchObject({ safe: false, guard: 'checkout' });
  });

  it('refuses a form carrying a personal-data field, naming the field, not its value', () => {
    const verdict = guardControl(
      control({
        fields: [field({ name: 'id' }), field({ type: 'email', name: 'contact[email]' })],
      }),
    );
    expect(verdict).toEqual({ safe: false, guard: 'personal_data', detail: 'contact[email]' });
  });
});
