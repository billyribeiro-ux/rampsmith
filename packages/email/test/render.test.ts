import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  createEmailRenderer,
  EMAIL_KINDS,
  InputError,
  POSTAL_ADDRESS_PLACEHOLDER,
  SettingsError,
  type Category,
} from '../src/index.ts';
import { TEMPLATES } from '../src/kinds.ts';
import { fixture, FIXTURES, SETTINGS, SITE } from './fixtures.ts';
import {
  attributeNames,
  hrefs,
  renderAll,
  renderer,
  tagNames,
  visibleHtmlText,
} from './helpers.ts';

const rendered = renderAll();

/** Plain text with line wrapping and note markers undone, for phrase checks. */
function flat(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\| ?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ');
}

/** Shown in HTML only: plain text already prints every link in full. */
const HTML_ONLY = 'If the button does not work, copy this address into your browser:';

/** The tags and attributes the renderer writes; anything else came from an input. */
const ALLOWED_TAGS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'div',
  'p',
  'h1',
  'h2',
  'ul',
  'li',
  'table',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'bdi',
  'br',
  'code',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'lang',
  'dir',
  'charset',
  'name',
  'content',
  'class',
  'style',
  'role',
  'aria-roledescription',
  'aria-label',
  'href',
  'scope',
]);

/** Emails that report scan results carry the automated-checks disclaimer (PLAN §3). */
const WITH_DISCLAIMER = new Set([
  'scanner_report',
  'welcome',
  'first_scan_complete',
  'weekly_summary',
  'fix_verified',
]);

describe('coverage', () => {
  it('has a template and at least one fixture for every kind', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...EMAIL_KINDS].sort());
    for (const kind of EMAIL_KINDS) {
      expect(FIXTURES[kind].length, kind).toBeGreaterThan(0);
    }
  });

  it('covers every category', () => {
    const used = new Set(rendered.map((r) => r.email.category));
    expect([...used].sort()).toEqual([...CATEGORIES].sort());
  });
});

describe.each(rendered)('$kind ($name)', ({ kind, name, input, email }) => {
  it('matches the reviewed snapshots', async () => {
    await expect(email.html).toMatchFileSnapshot(`./emails/${kind}.${name}.html.snapshot`);
    await expect(email.text).toMatchFileSnapshot(`./emails/${kind}.${name}.txt.snapshot`);
    await expect(
      `Subject: ${email.subject}\nPreview: ${email.preheader}\n${Object.entries(email.headers)
        .map(([header, value]) => `${header}: ${value}`)
        .join('\n')}\n`,
    ).toMatchFileSnapshot(`./emails/${kind}.${name}.headers.snapshot`);
  });

  it('is a complete HTML document with a language, a title and one h1', () => {
    expect(email.html.startsWith('<!doctype html>\n<html lang="')).toBe(true);
    expect(email.html).toMatch(/<html lang="en(?:-GB)?" dir="ltr">/u);
    expect(email.html).toContain('<meta charset="utf-8">');
    expect(email.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(email.html).toMatch(/<title>[^<]+<\/title>/u);
    expect(email.html.match(/<h1[\s>]/gu)).toHaveLength(1);
    expect(email.html).toContain('role="article" aria-roledescription="email"');
  });

  it('uses only the markup the renderer writes', () => {
    expect([...tagNames(email.html)].filter((t) => !ALLOWED_TAGS.has(t))).toEqual([]);
    expect([...attributeNames(email.html)].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual([]);
  });

  it('loads nothing: no images, scripts, fonts, stylesheets or tracking pixels', () => {
    for (const forbidden of [
      /<img/iu,
      /\ssrc=/iu,
      /url\(/iu,
      /@import/iu,
      /<script/iu,
      /<link/iu,
    ]) {
      expect(email.html).not.toMatch(forbidden);
    }
  });

  it('links only to the addresses its input gave, unchanged, plus support', () => {
    const given = JSON.stringify(input);
    for (const href of hrefs(email.html)) {
      if (href.startsWith('mailto:')) {
        expect(href).toBe(`mailto:${SETTINGS.supportAddress}`);
      } else {
        expect(given, href).toContain(JSON.stringify(href).slice(1, -1));
        expect(href).not.toMatch(/[?&](?:utm_|mc_|_hs|fbclid|gclid)/u);
      }
    }
  });

  it('says the same thing in plain text and HTML', () => {
    const words = (text: string) =>
      new Set(
        text
          .split(/\s+/u)
          .filter((w) => !/^\(?(?:https?:|mailto:)/u.test(w))
          .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
          .filter((w) => w.length > 0),
      );
    const fromText = words(email.text);
    const fromHtml = words(visibleHtmlText(email.html).replace(HTML_ONLY, ''));
    expect([...fromText].filter((w) => !fromHtml.has(w))).toEqual([]);
    expect([...fromHtml].filter((w) => !fromText.has(w))).toEqual([]);
  });

  it('keeps the subject and preview text on one line', () => {
    expect(email.subject).not.toMatch(/[\r\n]/u);
    expect(email.preheader).not.toMatch(/[\r\n]/u);
    expect(email.subject.length).toBeLessThanOrEqual(150);
  });

  it('carries the footer its category requires (ADR-191)', () => {
    const category: Category = email.category;
    const hasPostal = email.text.includes('100 Example Street');
    const hasUnsubscribeHeader = 'List-Unsubscribe' in email.headers;
    expect(flat(email.text)).toMatch(/You received this email because/u);
    expect(flat(email.text)).toContain(`Questions? Write to ${SETTINGS.supportAddress}.`);
    switch (category) {
      case 'security':
        expect(hasPostal).toBe(false);
        expect(hasUnsubscribeHeader).toBe(false);
        break;
      case 'transactional':
        expect(hasPostal).toBe(true);
        expect(hasUnsubscribeHeader).toBe(false);
        break;
      case 'notification':
        expect(hasPostal).toBe(true);
        expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        expect(email.text).toContain('Manage email preferences:');
        expect(email.text).toContain('Turn off emails like this one:');
        break;
      case 'marketing':
        expect(hasPostal).toBe(true);
        expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        expect(email.text).toContain('Unsubscribe from Rampsmith emails:');
        break;
    }
    if (hasUnsubscribeHeader) {
      const header = email.headers['List-Unsubscribe'] ?? '';
      expect(header).toMatch(/^<https:\/\/[^<>\s]+>$/u);
      expect(email.html).toContain(`href="${header.slice(1, -1).replaceAll('&', '&amp;')}"`);
    }
    expect(email.problems).toEqual([]);
  });

  it('states that automated checks find only part of all issues where it reports results', () => {
    const text = flat(email.text);
    const disclaimer = text.includes('Automated checks find only part of all accessibility');
    expect(disclaimer).toBe(WITH_DISCLAIMER.has(kind));
    if (disclaimer) {
      expect(text).toContain('finds on average 57% of WCAG issues automatically');
      expect(visibleHtmlText(email.html)).toContain('57% of WCAG issues');
    }
  });
});

describe('locale and time zone', () => {
  it('formats dates for the requested regional variant and zone', () => {
    const email = renderer.render('first_scan_complete', {
      ...fixture('first_scan_complete'),
      locale: 'en-GB',
      timeZone: 'Asia/Tokyo',
    });
    expect(email.lang).toBe('en-GB');
    expect(email.html).toContain('<html lang="en-GB" dir="ltr">');
    expect(flat(email.text)).toContain('on 18 October 2026'); // 18:30 UTC is 03:30 next day in Tokyo
  });

  it('falls back to English for a language without a catalog', () => {
    const email = renderer.render('delivery_test', {
      requestedAt: '2026-10-17T21:05:00Z',
      locale: 'fr-CA',
    });
    expect(email.lang).toBe('en');
  });

  it('shows times with their zone', () => {
    const email = renderer.render('delivery_test', { requestedAt: '2026-10-17T21:05:00Z' });
    expect(flat(email.text)).toContain('October 17, 2026 at 9:05 PM UTC');
  });
});

describe('settings', () => {
  it('block marketing email until the postal address is set, and nothing else', () => {
    const r = createEmailRenderer({
      appOrigin: SETTINGS.appOrigin,
      siteOrigin: SETTINGS.siteOrigin,
      supportAddress: SETTINGS.supportAddress,
    });
    const marketing = r.render('scanner_report', fixture('scanner_report'));
    expect(marketing.problems).toEqual(['postal-address-missing']);
    expect(marketing.text).toContain(POSTAL_ADDRESS_PLACEHOLDER);
    // Required notices still go out: the law asks for the address in commercial email only.
    for (const [kind, input] of [
      ['weekly_summary', fixture('weekly_summary')],
      ['data_deletion', fixture('data_deletion')],
      ['incident_notice', fixture('incident_notice')],
      ['sign_in_link', fixture('sign_in_link')],
    ] as const) {
      const email = r.renderUnknown(kind, input);
      expect(email.problems, kind).toEqual([]);
      expect(email.text).not.toContain(POSTAL_ADDRESS_PLACEHOLDER);
    }
  });

  it('flag an unsubscribe link without HTTPS (local development)', () => {
    const r = createEmailRenderer({ ...SETTINGS, appOrigin: 'http://localhost:5173' });
    const email = r.render('welcome', {
      ...fixture('welcome'),
      unsubscribeUrl: 'http://localhost:5173/email/unsubscribe?t=x',
      preferencesUrl: 'http://localhost:5173/settings/email',
    });
    expect(email.problems).toEqual(['unsubscribe-not-https']);
  });

  it.each([
    ['appOrigin', { appOrigin: 'http://app.rampsmith.example' }],
    ['siteOrigin', { siteOrigin: 'https://rampsmith.example/path' }],
    ['supportAddress', { supportAddress: 'Support <support@rampsmith.example>' }],
    ['postalAddress', { postalAddress: '   ' }],
    ['postalAddress', { postalAddress: 'x'.repeat(301) }],
  ])('reject a bad %s', (_name, change) => {
    expect(() => createEmailRenderer({ ...SETTINGS, ...change })).toThrow(SettingsError);
  });

  it('need the base catalog', () => {
    expect(() => createEmailRenderer(SETTINGS, { catalogs: {} })).toThrow(/base locale/u);
  });
});

describe('input errors', () => {
  it('reject an unknown kind', () => {
    expect(() => renderer.renderUnknown('password_reset', {})).toThrow(InputError);
  });

  it.each([
    ['a missing field', 'sign_in_link', { expiresInMinutes: 15 }, 'input.signInUrl'],
    [
      'a sign-in link on the site origin',
      'sign_in_link',
      { signInUrl: `${SITE}/sign-in`, expiresInMinutes: 15 },
      'input.signInUrl',
    ],
    [
      'more passed checks than total',
      'scanner_report',
      { ...fixture('scanner_report'), checks: { passed: 51, total: 50 } },
      'input.checks.passed',
    ],
    [
      'a store deletion without the store',
      'data_deletion',
      { scope: 'store', completedAt: '2026-10-19T00:00:00Z', billingRecordsKept: false },
      'input.storeName',
    ],
    [
      'an empty verification result',
      'fix_verified',
      {
        ...fixture('fix_verified'),
        verified: [],
        moreVerified: 0,
        notVerified: [],
        moreNotVerified: 0,
      },
      'input.verified',
    ],
    [
      'usage above the limit',
      'usage_limit',
      { ...fixture('usage_limit'), used: 2001 },
      'input.used',
    ],
    [
      'an extra field',
      'welcome',
      { ...fixture('welcome'), ownerEmail: 'owner@example.com' },
      'input.ownerEmail',
    ],
  ])('reject %s', (_name, kind, input, path) => {
    expect(() => renderer.renderUnknown(kind, input)).toThrow(
      expect.objectContaining({ name: 'InputError', path }),
    );
  });
});
