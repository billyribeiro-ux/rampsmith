import { describe, expect, it } from 'vitest';
import {
  checkOutbound,
  createEmailRenderer,
  describeForLog,
  guardSender,
  MAX_ATTACHMENT_BYTES,
  MemorySender,
  RenderedEmail,
  SendRefusedError,
  type EmailAttachment,
  type EmailSender,
  type OutboundEmail,
} from '../src/index.ts';
import { fixture, SETTINGS, SIGN_IN_TOKEN } from './fixtures.ts';
import { renderer } from './helpers.ts';

const email = renderer.render('sign_in_link', fixture('sign_in_link'));
const message: OutboundEmail = {
  to: 'merchant@shop.example',
  idempotencyKey: 'email.send:0192f3a4-0000-7000-8000-000000000001',
  email,
};

describe('checkOutbound', () => {
  it('accepts a rendered email to one plain address with a key', () => {
    expect(checkOutbound(message)).toEqual([]);
  });

  it.each([
    'Merchant <merchant@shop.example>',
    'merchant@shop.example, other@shop.example',
    'merchant@shop.example\r\nBcc: other@shop.example',
    'not an address',
    '',
  ])('refuses the recipient %j', (to) => {
    expect(checkOutbound({ ...message, to })).toEqual(['recipient-invalid']);
  });

  it.each(['', 'short', 'has space in it', 'line\nbreak-key-1234', 'k'.repeat(201)])(
    'refuses the idempotency key %j',
    (idempotencyKey) => {
      expect(checkOutbound({ ...message, idempotencyKey })).toEqual(['idempotency-key-invalid']);
    },
  );

  it('refuses content that render() did not produce', () => {
    const forged = {
      kind: email.kind,
      category: email.category,
      lang: email.lang,
      subject: email.subject,
      preheader: email.preheader,
      text: email.text,
      html: '<p>Hello</p>',
      headers: email.headers,
      problems: email.problems,
    } as unknown as RenderedEmail;
    expect(checkOutbound({ ...message, email: forged })).toEqual(['not-rendered']);
    expect(() => new RenderedEmail(Symbol('RenderedEmail'), email)).toThrow(TypeError);
  });

  it('refuses an email that is missing its postal address', () => {
    const noAddress = createEmailRenderer({
      appOrigin: SETTINGS.appOrigin,
      siteOrigin: SETTINGS.siteOrigin,
      supportAddress: SETTINGS.supportAddress,
    }).render('scanner_report', fixture('scanner_report'));
    expect(checkOutbound({ ...message, email: noAddress })).toEqual(['postal-address-missing']);
  });

  it('cannot be fooled by mutating a rendered email', () => {
    expect(Object.isFrozen(email)).toBe(true);
    expect(Object.isFrozen(email.headers)).toBe(true);
    expect(() => {
      (email as unknown as { subject: string }).subject = 'x\r\nBcc: a@example.com';
    }).toThrow(TypeError);
  });
});

describe('attachments', () => {
  const csv = (over: Partial<EmailAttachment> = {}): EmailAttachment => ({
    fileName: 'rampsmith-remediation-record.csv',
    contentType: 'text/csv',
    data: new TextEncoder().encode('a,b\n1,2\n'),
    ...over,
  });

  it('accepts a named CSV and refuses nothing else about the message', () => {
    expect(checkOutbound({ ...message, attachments: [csv()] })).toEqual([]);
  });

  it.each([
    ['a path in the name', csv({ fileName: '../record.csv' })],
    ['a name with a line break', csv({ fileName: 'a\r\nBcc: x@y.example' })],
    ['a name that is empty', csv({ fileName: '' })],
    ['a type that runs code', csv({ contentType: 'text/html' })],
    ['a type that is an executable', csv({ contentType: 'application/x-msdownload' })],
    ['more than the cap', csv({ data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) })],
  ])('refuses %s', (_why, file) => {
    expect(checkOutbound({ ...message, attachments: [file] })).toEqual(['attachment-invalid']);
  });

  it('refuses three files, and two that together pass the cap', () => {
    expect(checkOutbound({ ...message, attachments: [csv(), csv(), csv()] })).toEqual([
      'attachment-invalid',
    ]);
    const half = new Uint8Array(MAX_ATTACHMENT_BYTES / 2 + 1);
    expect(
      checkOutbound({ ...message, attachments: [csv({ data: half }), csv({ data: half })] }),
    ).toEqual(['attachment-invalid']);
  });

  it('hands the inner sender the checked, frozen list', async () => {
    const seen: OutboundEmail[] = [];
    const sender = guardSender({
      send(m) {
        seen.push(m);
        return Promise.resolve({ status: 'sent', messageId: 'x' });
      },
    });
    await sender.send({ ...message, attachments: [csv()] });
    expect(seen[0]?.attachments).toHaveLength(1);
    expect(Object.isFrozen(seen[0]?.attachments)).toBe(true);
  });
});

describe('guardSender', () => {
  it('passes accepted messages to the inner sender', async () => {
    const inner = new MemorySender();
    const receipt = await guardSender(inner).send(message);
    expect(receipt).toEqual({ status: 'sent', messageId: 'memory-1' });
    expect(inner.sent).toHaveLength(1);
  });

  it('never calls the inner sender for a refused message', async () => {
    let called = false;
    const inner: EmailSender = {
      send() {
        called = true;
        return Promise.resolve({ status: 'sent', messageId: 'x' });
      },
    };
    await expect(guardSender(inner).send({ ...message, to: 'a@b' })).rejects.toThrow(
      SendRefusedError,
    );
    expect(called).toBe(false);
  });

  it('reports every reason at once', async () => {
    await expect(
      guardSender(new MemorySender()).send({ ...message, to: 'bad', idempotencyKey: 'bad' }),
    ).rejects.toMatchObject({ reasons: ['recipient-invalid', 'idempotency-key-invalid'] });
  });
});

describe('MemorySender', () => {
  it('sends each idempotency key once', async () => {
    const sender = new MemorySender();
    await sender.send(message);
    expect(await sender.send(message)).toEqual({ status: 'duplicate' });
    expect(sender.sent).toHaveLength(1);
  });
});

describe('describeForLog', () => {
  it('holds no address, subject, body or token', () => {
    const logged = JSON.stringify(describeForLog(message));
    expect(logged).not.toContain('merchant@shop.example');
    expect(logged).not.toContain(SIGN_IN_TOKEN);
    expect(logged).not.toContain(email.subject);
    expect(describeForLog(message)).toEqual({
      kind: 'sign_in_link',
      category: 'security',
      lang: 'en',
      idempotencyKey: message.idempotencyKey,
    });
  });
});
