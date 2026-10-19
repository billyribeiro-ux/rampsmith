import { describe, expect, it } from 'vitest';
import { markup, rawHtml } from '../src/html.ts';
import {
  CATALOGS,
  LOCALES,
  checkCatalog,
  parseCatalog,
  resolveLocale,
  translator,
} from '../src/i18n.ts';

describe('resolveLocale', () => {
  it('uses a supported locale, matching its language subtag', () => {
    expect(resolveLocale('en')).toEqual({ locale: 'en', fallback: false });
    expect(resolveLocale('en-GB')).toEqual({ locale: 'en', fallback: false });
    expect(resolveLocale('EN_us')).toEqual({ locale: 'en', fallback: false });
  });

  it('falls back to English for a locale without a catalog, and says so', () => {
    expect(resolveLocale('fr-CA')).toEqual({ locale: 'en', fallback: true });
    expect(resolveLocale('')).toEqual({ locale: 'en', fallback: true });
    expect(resolveLocale('<script>')).toEqual({ locale: 'en', fallback: true });
  });
});

describe('parseCatalog', () => {
  const catalog = parseCatalog({
    $schema: 'https://inlang.com/schema/inlang-message-format',
    hello: 'Hello {name}',
    braces: 'Use \\{name\\} literally',
    items: [
      {
        declarations: ['input count', 'local countPlural = count: plural'],
        selectors: ['countPlural'],
        match: {
          'countPlural=one': '{count} item',
          'countPlural=*': '{count} items',
        },
      },
    ],
  });

  it('reads simple messages with placeholders and escaped braces', () => {
    expect(catalog.get('hello')).toEqual({
      kind: 'simple',
      pattern: [{ text: 'Hello ' }, { name: 'name' }],
    });
    expect(catalog.get('braces')).toEqual({
      kind: 'simple',
      pattern: [{ text: 'Use {name} literally' }],
    });
  });

  it('reads a plural message in the inlang message format', () => {
    const items = catalog.get('items');
    expect(items?.kind).toBe('plural');
  });

  it.each([
    [{ bad: 'unclosed {name' }, /unclosed placeholder/u],
    [{ bad: 'stray } brace' }, /unmatched "\}"/u],
    [{ bad: '{not valid}' }, /placeholder/u],
    [{ bad: '{n: number}' }, /placeholder/u],
    [{ bad: 42 }, /must be a string/u],
    [{ bad: [{ declarations: [], selectors: ['x'], match: {} }] }, /plural/u],
    [
      {
        bad: [
          {
            declarations: ['input count', 'local countPlural = count: plural'],
            selectors: ['countPlural'],
            match: { 'countPlural=one': 'x' },
          },
        ],
      },
      /catch-all/u,
    ],
    [
      {
        bad: [
          {
            declarations: ['input count', 'local countPlural = count: plural'],
            selectors: ['countPlural'],
            match: { 'countPlural=some': 'x', 'countPlural=*': 'y' },
          },
        ],
      },
      /category/u,
    ],
  ])('refuses a malformed message %#', (input, error) => {
    expect(() => parseCatalog(input)).toThrow(error);
  });
});

describe('translator', () => {
  const t = translator('en');

  it('formats simple and plural messages, with numbers in the locale', () => {
    expect(t.text('statement_status_heading')).toBe('Status against WCAG 2.2 Level AA');
    expect(t.text('summary_open_findings_count', { count: 1 })).toBe('1 open finding');
    expect(t.text('summary_open_findings_count', { count: 1234 })).toBe('1,234 open findings');
  });

  it('refuses a missing parameter instead of printing a placeholder', () => {
    expect(() => t.text('summary_open_findings_count', {})).toThrow(/count/u);
  });

  it('formats dates in UTC as a day, a month name and a year', () => {
    expect(t.date(new Date('2026-10-17T23:30:00Z'))).toBe('October 17, 2026');
    expect(t.date(new Date('2026-10-18T00:30:00+02:00'))).toBe('October 17, 2026');
  });

  it('formats a ratio as a percentage with one decimal place at most', () => {
    expect(t.percent(0.5)).toBe('50%');
    expect(t.percent(0.9876)).toBe('98.8%');
  });

  it('escapes message text and string parameters in HTML, and keeps HTML parameters', () => {
    const out = t.html('statement_feedback_email', {
      email: markup`<a href="mailto:a@example.com">${'a@example.com'}</a>`,
    });
    expect(out.toString()).toBe('Email: <a href="mailto:a@example.com">a@example.com</a>');
    const hostile = t.html('statement_feedback_email', { email: '<img src=x onerror=alert(1)>' });
    expect(hostile.toString()).toBe('Email: &lt;img src=x onerror=alert(1)&gt;');
  });

  it('never treats a parameter as markup unless it is already HTML', () => {
    expect(t.html('statement_feedback_email', { email: rawHtml('<b>ok</b>') }).toString()).toBe(
      'Email: <b>ok</b>',
    );
  });
});

describe('every catalog', () => {
  it.each(LOCALES)('%s has the same keys, placeholders and plural forms as English', (locale) => {
    expect(checkCatalog(CATALOGS.en, CATALOGS[locale])).toEqual([]);
  });

  it('reports a key that is missing, extra, or uses different placeholders', () => {
    const base = parseCatalog({ a: 'A {x}', b: 'B' });
    const other = parseCatalog({ a: 'A {y}', c: 'C' });
    expect(checkCatalog(base, other)).toEqual([
      'a: placeholders {y} differ from {x}',
      'b: missing',
      'c: not in the base catalog',
    ]);
  });
});
