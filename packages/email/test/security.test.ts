/**
 * Hostile inputs and secrets (ADR-193): every input is escaped, links cannot be redirected,
 * and the sign-in token and store-link code appear only where they must.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { InputError, type EmailKind, type RenderedEmail } from '../src/index.ts';
import {
  allFixtures,
  fixture,
  LINK_CODE,
  SIGN_IN_TOKEN,
  UNSUBSCRIBE_TOKEN,
  VERIFY_TOKEN,
} from './fixtures.ts';
import { attributeNames, decodeEntities, hrefs, renderer, tagNames } from './helpers.ts';

const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</p><a href="https://evil.example/">Verify your account</a><p>',
  '<style>body{display:none}</style>',
  '<!-- comment --><![CDATA[ x ]]>',
  '{store} {token} \\{x\\}',
  '${7*7} {{7*7}} #{7*7}',
  'Shop\r\nBcc: victim@example.com',
  'Shop\u202Egnp.exe',
  'javascript:alert(1)',
  '&amp;&lt;&#x3C;',
  'Click https://evil.example/login now',
  'x'.repeat(5000),
];

const ALLOWED_TAGS = new Set(
  'html head meta title style body div p h1 h2 ul li table tbody tr th td a bdi br code'.split(' '),
);
const ALLOWED_ATTRIBUTES = new Set(
  'lang dir charset name content class style role aria-roledescription aria-label href scope'.split(
    ' ',
  ),
);

function assertSafe(email: RenderedEmail): void {
  expect([...tagNames(email.html)].filter((t) => !ALLOWED_TAGS.has(t))).toEqual([]);
  expect([...attributeNames(email.html)].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual([]);
  for (const href of hrefs(email.html)) {
    expect(href).toMatch(
      /^(?:https:\/\/(?:app\.rampsmith\.example|rampsmith\.example|admin\.shopify\.com)\/|mailto:support@rampsmith\.example$)/u,
    );
  }
  expect(email.subject).not.toMatch(/[\r\n\u2028\u2029]/u);
  expect(email.preheader).not.toMatch(/[\r\n\u2028\u2029]/u);
  expect(email.html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
  expect(email.text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
  for (const value of Object.values(email.headers)) {
    expect(value).not.toMatch(/[\r\n]/u);
  }
}

/** Every path to a string inside `value`. */
function stringPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === 'string') {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) => stringPaths(item, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => stringPaths(item, [...path, key]));
  }
  return [];
}

function replaceAt(value: unknown, path: (string | number)[], replacement: string): unknown {
  const copy: unknown = structuredClone(value);
  let target = copy as Record<string | number, unknown>;
  path.slice(0, -1).forEach((key) => {
    target = target[key] as Record<string | number, unknown>;
  });
  const last = path.at(-1);
  if (last !== undefined) {
    target[last] = replacement;
  }
  return copy;
}

describe('hostile values in every string field of every email', () => {
  const cases = allFixtures().flatMap(([kind, name, input]) =>
    stringPaths(input).map((path): [EmailKind, string, string, unknown] => [
      kind,
      name,
      path.join('.'),
      input,
    ]),
  );

  it.each(cases)('%s (%s) field %s is escaped or rejected', (kind, _name, pathText, input) => {
    const path = pathText.split('.').map((p) => (/^\d+$/u.test(p) ? Number(p) : p));
    for (const hostile of HOSTILE) {
      let email: RenderedEmail;
      try {
        email = renderer.renderUnknown(kind, replaceAt(input, path, hostile));
      } catch (error: unknown) {
        // Links, dates, enums, codes and criteria reject anything unexpected.
        expect(error).toBeInstanceOf(InputError);
        continue;
      }
      assertSafe(email);
      expect(email.html).not.toContain('<script');
      expect(email.html).not.toContain('<img');
      expect(email.html).not.toContain('href="https://evil.example');
    }
  });

  it('treats a value that looks like a placeholder as text', () => {
    const email = renderer.render('weekly_summary', {
      ...fixture('weekly_summary'),
      storeName: '{store} {passed}',
    });
    expect(email.subject).toBe('Weekly accessibility summary for {store} {passed}');
  });

  it('isolates input text for direction in HTML', () => {
    const email = renderer.render('welcome', {
      ...fixture('welcome'),
      storeName: 'متجر الأمل',
    });
    expect(email.html).toContain('<bdi>متجر الأمل</bdi>');
  });
});

describe('seeded fuzzing of store names', () => {
  // A small deterministic generator, so a failure always reproduces.
  let seed = 0x5eed;
  function next(): number {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed;
  }
  const alphabet = [
    '<',
    '>',
    '"',
    "'",
    '&',
    '=',
    '/',
    '\\',
    '{',
    '}',
    '#',
    '$',
    '`',
    ';',
    ':',
    ' ',
    '\r',
    '\n',
    '\t',
    '\u0000',
    '\u202E',
    '\u2028',
    'a',
    'Z',
    '9',
    'é',
    '😀',
    '</p>',
    '<a ',
    'href=',
  ];

  it('keeps 300 random names inert in every store email', () => {
    const kinds: EmailKind[] = ['welcome', 'weekly_summary', 'regression_alert', 'store_linked'];
    for (let i = 0; i < 300; i += 1) {
      const length = 1 + (next() % 40);
      let name = 'S';
      for (let j = 0; j < length; j += 1) {
        name += alphabet[next() % alphabet.length] ?? '';
      }
      for (const kind of kinds) {
        const input = { ...fixture(kind), storeName: name };
        assertSafe(renderer.renderUnknown(kind, input));
      }
    }
  });
});

/** Where `secret` appears in `html`, as "href" (inside an href) or "link-text" (an anchor's text). */
function placements(html: string, secret: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(secret, from);
    if (at === -1) {
      return out;
    }
    const before = html.slice(0, at);
    const inHref = /\shref="[^"]*$/u.test(before);
    const inAnchorText = /<a [^>]*>[^<]*$/u.test(before);
    const inCode = /<code[^>]*>[^<]*$/u.test(before);
    out.push(inHref ? 'href' : inAnchorText ? 'link-text' : inCode ? 'code' : 'elsewhere');
    from = at + secret.length;
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the sign-in token and other secrets', () => {
  it.each([
    ['sign_in_link', SIGN_IN_TOKEN],
    ['email_verification', VERIFY_TOKEN],
  ] as const)('%s: the token is only ever part of the link', (kind, token) => {
    const email = renderer.renderUnknown(kind, fixture(kind));
    expect(email.subject).not.toContain(token);
    expect(email.preheader).not.toContain(token);
    expect(JSON.stringify(email.headers)).not.toContain(token);
    // HTML: the button's href, the fallback link's href and that link's own text.
    expect(placements(email.html, token).sort()).toEqual(['href', 'href', 'link-text']);
    // Plain text: exactly once, on the line that is the link.
    expect(count(email.text, token)).toBe(1);
    const line = email.text.split('\n').find((l) => l.includes(token));
    expect(line).toMatch(/^https:\/\/app\.rampsmith\.example\/\S+$/u);
  });

  it('the store-link code appears once in each version, as the code, never in the subject', () => {
    const email = renderer.render('store_link_code', fixture('store_link_code'));
    expect(email.subject).not.toContain(LINK_CODE);
    expect(email.preheader).not.toContain(LINK_CODE);
    expect(placements(email.html, LINK_CODE)).toEqual(['code']);
    expect(count(email.text, LINK_CODE)).toBe(1);
  });

  it('logging a rendered email shows no token, link, subject, body or recipient data', () => {
    for (const [kind, , input] of allFixtures()) {
      const email = renderer.renderUnknown(kind, input);
      const logged = `${JSON.stringify(email)}\n${inspect(email, { depth: 5 })}`;
      for (const secret of [SIGN_IN_TOKEN, VERIFY_TOKEN, LINK_CODE, UNSUBSCRIBE_TOKEN]) {
        expect(logged).not.toContain(secret);
      }
      expect(logged).not.toContain('Example Outfitters');
      expect(logged).not.toContain(email.subject);
      expect(logged).toContain(kind);
    }
  });

  it('error messages never repeat the rejected value', () => {
    const secret = 'SECRET-TOKEN-VALUE-123';
    expect(() =>
      renderer.render('sign_in_link', {
        signInUrl: `https://evil.example/?t=${secret}`,
        expiresInMinutes: 15,
      }),
    ).toThrow(expect.not.stringContaining(secret));
    try {
      renderer.render('sign_in_link', {
        signInUrl: `https://evil.example/?t=${secret}`,
        expiresInMinutes: 15,
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret);
      expect(inspect(error)).not.toContain(secret);
    }
  });

  it('rejects a sign-in link pointing anywhere but the app', () => {
    for (const signInUrl of [
      'https://admin.shopify.com/store/x',
      'https://rampsmith.example/sign-in',
      'https://app.rampsmith.example@evil.example/',
      'javascript:alert(1)',
    ]) {
      expect(() => renderer.render('sign_in_link', { signInUrl, expiresInMinutes: 15 })).toThrow(
        InputError,
      );
    }
  });
});

describe('operator-written text', () => {
  it('fails the render on a banned claim', () => {
    expect(() =>
      renderer.render('incident_notice', {
        ...fixture('incident_notice'),
        whatWeAreDoing: 'Your store remains fully compliant with the ADA.',
      }),
    ).toThrow(/contains a banned claim \(absolute-accessibility\)/u);
  });

  it('keeps operator text as text', () => {
    const email = renderer.render('incident_notice', {
      ...fixture('incident_notice', 1),
      whatHappened: 'A <b>bold</b> claim & a link: https://evil.example/',
    });
    expect(decodeEntities(email.html)).toContain('A <b>bold</b> claim & a link');
    expect(email.html).toContain('A &lt;b&gt;bold&lt;/b&gt; claim &amp; a link');
    expect(hrefs(email.html).some((h) => h.includes('evil.example'))).toBe(false);
  });
});
