import { describe, expect, it } from 'vitest';
import type { Origins } from '../src/links.ts';
import {
  bool,
  count,
  criterion,
  hostname,
  InputError,
  instant,
  int,
  label,
  link,
  list,
  localeTag,
  object,
  oneOf,
  optional,
  pattern,
  prose,
  refine,
  timeZone,
  type Schema,
} from '../src/schema.ts';

const ctx: { origins: Origins } = {
  origins: {
    app: 'https://app.rampsmith.example',
    site: 'https://rampsmith.example',
    shopifyAdmin: 'https://admin.shopify.com',
  },
};

function parse<I, O>(schema: Schema<I, O>, value: unknown): O {
  return schema.parse(value, 'input', ctx);
}

function failure(schema: Schema<unknown, unknown>, value: unknown): InputError {
  try {
    schema.parse(value, 'input', ctx);
  } catch (error: unknown) {
    if (error instanceof InputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an InputError');
}

describe('label', () => {
  it('cleans and keeps a short name', () => {
    expect(parse(label(20), '  Acme\nShop  ')).toBe('Acme Shop');
  });

  it('shortens long names with an ellipsis instead of failing', () => {
    expect(parse(label(10), 'Example Outfitters International')).toBe('Example O…');
  });

  it('rejects empty and non-string values', () => {
    expect(failure(label(10), '  \u202E ').reason).toBe('must not be empty');
    expect(failure(label(10), 42).reason).toBe('must be a string, not number');
    expect(failure(label(10), null).reason).toBe('must be a string, not null');
  });
});

describe('prose', () => {
  it('keeps paragraphs', () => {
    expect(parse(prose(100), 'One.\n\n\n\nTwo\nlines.')).toBe('One.\n\nTwo\nlines.');
  });

  it('rejects text over the limit rather than cutting it', () => {
    expect(failure(prose(5), 'too long').reason).toBe('must be at most 5 characters');
  });
});

describe('numbers, booleans and enums', () => {
  it('accepts whole numbers in range', () => {
    expect(parse(int(1, 60), 15)).toBe(15);
    expect(parse(count(), 0)).toBe(0);
  });

  it.each([1.5, Number.NaN, Infinity, '15', -1, 61, 2 ** 53])('rejects %j', (value) => {
    expect(() => parse(int(0, 60), value)).toThrow(InputError);
  });

  it('accepts only booleans for bool', () => {
    expect(parse(bool(), false)).toBe(false);
    expect(() => parse(bool(), 'false')).toThrow(InputError);
  });

  it('accepts only listed values for oneOf', () => {
    expect(parse(oneOf(['a', 'b'] as const), 'b')).toBe('b');
    expect(failure(oneOf(['a', 'b'] as const), 'c').reason).toBe('must be one of: a, b');
    expect(() => parse(oneOf(['a'] as const), ['a'])).toThrow(InputError);
  });

  it('matches patterns and WCAG criteria', () => {
    expect(parse(criterion(), '2.4.11')).toBe('2.4.11');
    expect(() => parse(criterion(), '5.1.1')).toThrow(InputError);
    expect(() => parse(criterion(), '1.1.1 ')).toThrow(InputError);
    expect(() => parse(pattern(/^x$/u, 'x'), 'xx')).toThrow(InputError);
  });
});

describe('instant', () => {
  it('reads RFC 3339 instants with an offset, nanoseconds included', () => {
    expect(parse(instant(), '2026-10-17T20:00:00Z').toISOString()).toBe('2026-10-17T20:00:00.000Z');
    expect(parse(instant(), '2026-10-17T22:00:00.123456789+02:00').toISOString()).toBe(
      '2026-10-17T20:00:00.123Z',
    );
  });

  it.each([
    '2026-10-17',
    '2026-10-17T20:00:00',
    '2026-13-01T00:00:00Z',
    'yesterday',
    '1999-12-31T23:59:59Z',
    1_760_000_000_000,
  ])('rejects %j', (value) => {
    expect(() => parse(instant(), value)).toThrow(InputError);
  });
});

describe('link', () => {
  it('returns the normalised link', () => {
    expect(parse(link(['app']), 'https://app.rampsmith.example/a')).toBe(
      'https://app.rampsmith.example/a',
    );
  });

  it('names the allowed origins but never echoes the value, which may hold a token', () => {
    const error = failure(link(['app']), 'https://evil.example/?token=SECRET-VALUE');
    expect(error.message).toBe(
      'input: must be an absolute link on the app origin, without credentials',
    );
    expect(error.message).not.toContain('SECRET-VALUE');
  });
});

describe('hostname', () => {
  it('returns the ASCII form', () => {
    expect(parse(hostname(), 'Shop.Example')).toBe('shop.example');
    expect(parse(hostname(), 'bücher.example')).toBe('xn--bcher-kva.example');
  });

  it.each([
    'https://shop.example',
    'shop.example/path',
    'user@shop.example',
    'shop.example:8080',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'shop .example',
    '',
  ])('rejects %j', (value) => {
    expect(() => parse(hostname(), value)).toThrow(InputError);
  });
});

describe('locale and time zone', () => {
  it('canonicalises language tags', () => {
    expect(parse(localeTag(), 'en-gb')).toBe('en-GB');
    expect(() => parse(localeTag(), 'not a tag')).toThrow(InputError);
    expect(() => parse(localeTag(), 'x'.repeat(40))).toThrow(InputError);
  });

  it('accepts IANA time zones', () => {
    expect(parse(timeZone(), 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(() => parse(timeZone(), 'Mars/Olympus')).toThrow(InputError);
  });
});

describe('object, list and optional', () => {
  const shape = object({
    name: label(20),
    note: optional(label(20)),
    items: list(int(0, 9), { min: 1, max: 2 }),
  });

  it('parses a valid object and omits absent optional fields', () => {
    expect(parse(shape, { name: 'A', items: [1] })).toEqual({ name: 'A', items: [1] });
    expect(parse(shape, { name: 'A', note: 'n', items: [1, 2] })).toEqual({
      name: 'A',
      note: 'n',
      items: [1, 2],
    });
  });

  it('rejects unknown fields, so no extra personal data rides along', () => {
    expect(failure(shape, { name: 'A', items: [1], email: 'a@example.com' }).path).toBe(
      'input.email',
    );
  });

  it('names the failing path', () => {
    expect(failure(shape, { items: [1] }).path).toBe('input.name');
    expect(failure(shape, { name: 'A', items: [1, 99] }).path).toBe('input.items[1]');
    expect(failure(shape, { name: 'A', items: [] }).reason).toBe('must hold 1 to 2 items');
    expect(failure(shape, { name: 'A', items: [1, 2, 3] }).reason).toBe('must hold 1 to 2 items');
  });

  it('rejects non-plain objects', () => {
    expect(() => parse(shape, [])).toThrow(InputError);
    expect(() => parse(shape, new Date())).toThrow(InputError);
    expect(() => parse(shape, null)).toThrow(InputError);
  });

  it('rejects a __proto__ key without polluting prototypes', () => {
    const hostile: unknown = JSON.parse('{"name":"A","items":[1],"__proto__":{"polluted":true}}');
    expect(failure(shape, hostile).path).toBe('input.<unknown field>');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('names an unknown key only when it is a plain identifier', () => {
    expect(failure(shape, { name: 'A', items: [1], ownerEmail: 'x' }).path).toBe(
      'input.ownerEmail',
    );
    const forged = 'victim@example.com\nlevel=info msg=forged';
    const error = failure(shape, { name: 'A', items: [1], [forged]: 1 });
    expect(error.path).toBe('input.<unknown field>');
    expect(error.message).not.toContain('victim@example.com');
  });

  it('checks rules across fields with refine', () => {
    const range = refine(
      object({ low: int(0, 9), high: int(0, 9) }),
      (v) => v.low <= v.high,
      'low',
      'must not exceed high',
    );
    expect(parse(range, { low: 1, high: 2 })).toEqual({ low: 1, high: 2 });
    expect(failure(range, { low: 3, high: 2 }).path).toBe('input.low');
  });
});
