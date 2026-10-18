// The barrier-report body rules the api must apply (ADR-162), as a reference the browser
// tests' fake app proxy also uses.
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PAGE_LENGTH,
  MIN_ELAPSED_MS,
  PAGE_TYPES,
  parseBarrierReport,
} from '../src/barrier-report.ts';

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
    ]) {
      const result = parseBarrierReport(form({ description: 'x', page }));
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
    expect(parseBarrierReport(form({ description: 'x', page }))).toEqual({
      kind: 'accepted',
      report: expect.objectContaining({ page }) as unknown,
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
