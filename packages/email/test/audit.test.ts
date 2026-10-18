/**
 * Regression tests for the security audit of this package (docs/evidence/ws-10-email.md).
 * Each block names the finding it closes.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createEmailRenderer,
  guardSender,
  InputError,
  MemorySender,
  SettingsError,
  type EmailSender,
  type OutboundEmail,
} from '../src/index.ts';
import { Catalog } from '../src/i18n.ts';
import type { Origins } from '../src/links.ts';
import { displayName, hostname, instant, label, localeTag, prose } from '../src/schema.ts';
import { graphemeLength } from '../src/sanitize.ts';
import { fixture, SETTINGS } from './fixtures.ts';
import { renderer } from './helpers.ts';

const ctx: { origins: Origins } = {
  origins: {
    app: SETTINGS.appOrigin,
    site: SETTINGS.siteOrigin,
    shopifyAdmin: 'https://admin.shopify.com',
  },
};

describe('finding 1: names chosen by someone other than the recipient', () => {
  it.each([
    'Rampsmith Security: verify at https://rampsmith-verify.example/login',
    'Verify at rampsmith-verify.example now',
    'Write to help@rampsmith-verify.example',
    'Go to www.evil',
    'HTTPS://EVIL.EXAMPLE',
  ])('rejects the agency name %j', (organizationName) => {
    expect(() =>
      renderer.render('agency_invitation', { ...fixture('agency_invitation'), organizationName }),
    ).toThrow(InputError);
  });

  it('accepts ordinary names, including ones with dots and versions', () => {
    for (const name of ['Northwind Studio', 'Dr. Smith & Co', 'Studio v2.0', 'Pixel. Agency']) {
      expect(displayName(100).parse(name, 'input', ctx)).toBe(name);
    }
  });

  it('keeps those names out of subjects and preview text', () => {
    const invitation = renderer.render('agency_invitation', fixture('agency_invitation'));
    const code = renderer.render('store_link_code', fixture('store_link_code'));
    const linked = renderer.render('store_linked', fixture('store_linked'));
    for (const email of [invitation, code, linked]) {
      expect(`${email.subject} ${email.preheader}`).not.toContain('Northwind Studio');
    }
    expect(`${code.subject} ${code.preheader}`).not.toContain('Example Outfitters');
    expect(invitation.text).toContain('“Northwind Studio”');
  });

  it('applies the same rule to the store name in a store-link code and the agency in a link notice', () => {
    expect(() =>
      renderer.render('store_link_code', {
        ...fixture('store_link_code'),
        storeName: 'Claim your prize at prize.example',
      }),
    ).toThrow(InputError);
    expect(() =>
      renderer.render('store_linked', {
        ...fixture('store_linked'),
        organizationName: 'support@evil.example',
      }),
    ).toThrow(InputError);
  });

  it('puts nothing the requester typed into the scanner confirmation', () => {
    expect(() =>
      renderer.renderUnknown('scanner_confirm', {
        ...fixture('scanner_confirm'),
        scannedHost: 'shop.example',
      }),
    ).toThrow(InputError);
  });
});

describe('finding 2: size of names and notices', () => {
  it('bounds a huge label before cleaning it', () => {
    const started = performance.now();
    const text = label(100).parse('A'.repeat(5_000_000), 'input', ctx);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(graphemeLength(text)).toBe(100);
  });

  it('caps runs of combining marks', () => {
    const zalgo = `Z${'\u0301'.repeat(100_000)}alpha`;
    const text = label(100).parse(zalgo, 'input', ctx);
    expect(text.length).toBeLessThan(40);
    const email = renderer.render('welcome', { ...fixture('welcome'), storeName: zalgo });
    expect(email.html.length).toBeLessThan(20_000);
  });

  it('rejects oversized operator text before cleaning it', () => {
    expect(() => prose(2000).parse('x'.repeat(10_000_000), 'input', ctx)).toThrow(
      /at most 2000 characters/u,
    );
  });
});

describe('finding 3: banned claims in operator text', () => {
  it.each([
    'Your store stays lawsuit-\nproof.',
    'You remain protected from\nlawsuits.',
    'The site is 100%\naccessible.',
    'Your store is com\u00ADpliant.',
    'We are cer\u200Btified.',
    'Your store is com\u2060pliant.',
  ])('finds %j', (whatWeAreDoing) => {
    expect(() =>
      renderer.render('incident_notice', { ...fixture('incident_notice'), whatWeAreDoing }),
    ).toThrow(/banned claim/u);
  });

  it('rejects an allow marker', () => {
    expect(() =>
      renderer.render('incident_notice', {
        ...fixture('incident_notice'),
        whatWeAreDoing: 'claims-lint-allow compliance: because we say so. All compliant.',
      }),
    ).toThrow(/allow marker/u);
  });
});

describe('finding 4: the guard checks and forwards one snapshot', () => {
  const email = renderer.render('sign_in_link', fixture('sign_in_link'));

  it('forwards the value it checked, not a later read of a getter', async () => {
    let reads = 0;
    const message = {
      get to() {
        reads += 1;
        return reads === 1
          ? 'merchant@shop.example'
          : 'merchant@shop.example\r\nBcc: a@evil.example';
      },
      idempotencyKey: 'email.send:snapshot-test',
      email,
    } as OutboundEmail;
    const received: OutboundEmail[] = [];
    const inner: EmailSender = {
      send(m) {
        received.push(m);
        return Promise.resolve({ status: 'sent', messageId: 'x' });
      },
    };
    await guardSender(inner).send(message);
    expect(received[0]?.to).toBe('merchant@shop.example');
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('refuses a recipient that is not a string', async () => {
    await expect(
      guardSender(new MemorySender()).send({
        to: ['x', '@', 'example.com'] as unknown as string,
        idempotencyKey: 'email.send:non-string',
        email,
      }),
    ).rejects.toMatchObject({ reasons: ['recipient-invalid'] });
  });

  it('keeps bodies and headers out of a spread copy', () => {
    // Object.assign copies own enumerable properties, exactly as a spread would.
    const copy: object = Object.assign({}, email);
    expect(JSON.stringify(copy)).not.toContain('token=');
    expect(Object.keys(copy)).not.toContain('html');
    expect(inspect(copy)).not.toContain('token=');
  });
});

describe('finding 7: smaller checks', () => {
  it('builds no mailto header fields from the support address', () => {
    expect(() =>
      createEmailRenderer({
        ...SETTINGS,
        supportAddress: 'x?cc=a%40evil.example@rampsmith.example',
      }),
    ).toThrow(SettingsError);
  });

  it('reads placeholder values from own properties only', () => {
    const catalog = new Catalog('en', { a: 'Value: {constructor}' });
    expect(() => catalog.formatParts('a', {}, 'en')).toThrow(/no value given/u);
  });

  it.each([
    'shop".example',
    'a&b.example',
    'localhost.',
    'shop.example.',
    'xn--.example',
    '1.2.3.4',
  ])('rejects the host %j', (value) => {
    expect(() => hostname().parse(value, 'input', ctx)).toThrow(InputError);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-10-17T24:00:00Z',
    '2026-10-17T10:60:00Z',
    '2026-10-17T10:00:00+24:00',
  ])('rejects the impossible instant %j', (value) => {
    expect(() => instant().parse(value, 'input', ctx)).toThrow(InputError);
  });

  it('accepts a leap day', () => {
    expect(instant().parse('2028-02-29T12:00:00Z', 'input', ctx).toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
  });

  it('drops Unicode extensions from language tags', () => {
    expect(localeTag().parse('en-GB-u-nu-arab-ca-islamic', 'input', ctx)).toBe('en-GB');
  });
});
