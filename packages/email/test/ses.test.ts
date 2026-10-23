/**
 * The Amazon SES adapter against a local stand-in for the SES v2 endpoint (ADR-270). The stand-in
 * checks the SigV4 signature, the credential scope, the clock and the body shape the way AWS
 * does, and answers with any of the errors the API reference lists for `SendEmail`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSesSender,
  encodeSubject,
  failureFor,
  guardSender,
  MemoryLedger,
  SendFailure,
  sesConfigFromEnv,
  SesConfigError,
  withLedger,
  type EmailSender,
  type OutboundEmail,
  type SesConfig,
} from '../src/index.ts';
import { startFakeSes, type FakeSes } from '../src/testing/fake-ses.ts';
import { fixture } from './fixtures.ts';
import { renderer } from './helpers.ts';

const ACCESS_KEY = 'AKIDTESTONLY0000000';
const SECRET = 'test-only-secret-key/not+a+credential';
const RECIPIENT = 'owner-of-fixture-store@shop.example';

let ses: FakeSes;
beforeAll(async () => {
  ses = await startFakeSes({
    region: 'eu-west-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
  });
});
afterAll(async () => {
  await ses.close();
});

function config(over: Partial<SesConfig> = {}): SesConfig {
  return {
    region: 'eu-west-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    from: 'Rampsmith <hello@rampsmith.example>',
    endpoint: ses.endpoint,
    ...over,
  };
}

function message(
  key: string,
  kind: 'sign_in_link' | 'weekly_summary' = 'sign_in_link',
): OutboundEmail {
  return {
    to: RECIPIENT,
    idempotencyKey: key,
    email: renderer.render(kind, fixture(kind)),
  };
}

async function failureOf(sender: EmailSender, key: string): Promise<SendFailure> {
  try {
    await sender.send(message(key));
  } catch (error) {
    expect(error).toBeInstanceOf(SendFailure);
    return error as SendFailure;
  }
  throw new Error('the send was expected to fail');
}

describe('the SES request', () => {
  it('is signed, addressed and shaped as the SendEmail API wants, and turns tracking off', async () => {
    const before = ses.requests.length;
    const sender = guardSender(createSesSender(config()));
    const receipt = await sender.send(message('email.send:request-shape-0001', 'weekly_summary'));
    expect(receipt.status).toBe('sent');
    expect(receipt.status === 'sent' && receipt.messageId).toMatch(/^fake-ses-\d{4}$/u);

    const request = ses.requests[before];
    expect(request?.signedHeaders).toEqual(['content-type', 'host', 'x-amz-date']);
    const body = request?.body;
    expect(body?.FromEmailAddress).toBe('Rampsmith <hello@rampsmith.example>');
    expect(body?.Destination.ToAddresses).toEqual([RECIPIENT]);
    const simple = body?.Content.Simple;
    expect(simple?.Body.Text?.Data).toContain('Example Outfitters');
    expect(simple?.Body.Html?.Data).toContain('<html');
    // The unsubscribe headers of a notification go out as SES headers (RFC 8058).
    const names = simple?.Headers?.map((h) => h.Name);
    expect(names).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
    expect(simple?.Headers?.[1]?.Value).toBe('List-Unsubscribe=One-Click');
    // No tracking pixel and no link rewriting, whatever the account or a configuration set say.
    expect(body?.ConfigurationOverrides?.Tracking).toEqual({
      OpenTrackingEnabled: 'DISABLED',
      ClickTrackingEnabled: 'DISABLED',
    });
    expect(Object.keys(body ?? {}).sort()).toEqual([
      'ConfigurationOverrides',
      'Content',
      'Destination',
      'FromEmailAddress',
    ]);
  });

  it('sends an attachment as base64 in Message.Attachments, with the shape the service model gives', async () => {
    const before = ses.requests.length;
    const refusedBefore = ses.rejected.length;
    const data = new TextEncoder().encode('Fix,Finding\r\nf1,"alt, text"\r\n');
    await createSesSender(config()).send({
      ...message('email.send:attachment-0000001'),
      attachments: [{ fileName: 'record.csv', contentType: 'text/csv', data }],
    });
    const attachments = ses.requests[before]?.body.Content.Simple.Attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]).toEqual({
      FileName: 'record.csv',
      ContentType: 'text/csv',
      ContentDisposition: 'ATTACHMENT',
      ContentTransferEncoding: 'BASE64',
      RawContent: Buffer.from(data).toString('base64'),
    });
    expect(ses.rejected).toHaveLength(refusedBefore);
  });

  it('sends no header for an email that has none', async () => {
    const before = ses.requests.length;
    await createSesSender(config()).send(message('email.send:no-headers-0000001'));
    expect(ses.requests[before]?.body.Content.Simple.Headers).toBeUndefined();
  });

  it('signs a session token when there is one', async () => {
    const before = ses.requests.length;
    await createSesSender(config({ sessionToken: 'TEST-SESSION-TOKEN' })).send(
      message('email.send:session-token-0001'),
    );
    expect(ses.requests[before]?.signedHeaders).toContain('x-amz-security-token');
  });

  it('encodes a non-ASCII subject as RFC 2047 words, and leaves ASCII alone', () => {
    expect(encodeSubject('Your sign-in link')).toBe('Your sign-in link');
    const encoded = encodeSubject('Votre lien de connexion à Rampsmith — expire dans 15 minutes');
    expect(encoded).toMatch(
      /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/u,
    );
    for (const word of encoded.split(' ')) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = encoded
      .split(' ')
      .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('Votre lien de connexion à Rampsmith — expire dans 15 minutes');
  });

  it('never splits a character across two encoded words', () => {
    const subject = '日本語のメール件名です。'.repeat(8);
    const words = encodeSubject(subject).split(' ');
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'));
    expect(decoded.join('')).toBe(subject);
    expect(decoded.join('')).not.toContain('�');
  });
});

describe('errors', () => {
  const table: readonly [number, string, 'defer' | 'permanent', string][] = [
    [429, 'TooManyRequestsException', 'defer', 'ses_throttled'],
    [400, 'LimitExceededException', 'defer', 'ses_quota_exceeded'],
    [400, 'SendingPausedException', 'defer', 'ses_sending_paused'],
    [400, 'MailFromDomainNotVerifiedException', 'defer', 'ses_sender_not_verified'],
    [400, 'AccountSuspendedException', 'permanent', 'ses_account_suspended'],
    [400, 'MessageRejected', 'permanent', 'ses_message_rejected'],
    [400, 'BadRequestException', 'permanent', 'ses_bad_request'],
    [404, 'NotFoundException', 'permanent', 'ses_not_found'],
    [403, 'UnrecognizedClientException', 'defer', 'ses_credentials_rejected'],
    [403, 'ExpiredTokenException', 'defer', 'ses_credentials_rejected'],
    [500, 'InternalFailure', 'defer', 'ses_unavailable'],
    [503, 'ServiceUnavailable', 'defer', 'ses_unavailable'],
    [418, 'SomethingNew', 'permanent', 'ses_request_refused'],
  ];

  it.each(table)('maps %i %s to %s %s', async (status, type, disposition, code) => {
    ses.failNext({ status, type });
    const failure = await failureOf(createSesSender(config()), `email.send:error-${type}-00`);
    expect(failure.disposition).toBe(disposition);
    expect(failure.code).toBe(code);
  });

  it('reads the error type from the longer form AWS sends', () => {
    const failure = failureFor(429, 'TooManyRequestsException', null);
    expect(failure.code).toBe('ses_throttled');
  });

  it('honours Retry-After, within a limit', async () => {
    ses.failNext({
      status: 429,
      type: 'TooManyRequestsException',
      headers: { 'retry-after': '7' },
    });
    expect(
      (await failureOf(createSesSender(config()), 'email.send:retry-after-0001')).retryAfterMs,
    ).toBe(7000);
    expect(failureFor(429, 'TooManyRequestsException', '999999').retryAfterMs).toBe(3_600_000);
    expect(failureFor(429, 'TooManyRequestsException', 'soon').retryAfterMs).toBeUndefined();
  });

  it('defers when the connection drops', async () => {
    ses.failNext({ status: 0, drop: true });
    const failure = await failureOf(createSesSender(config()), 'email.send:network-drop-0001');
    expect([failure.disposition, failure.code]).toEqual(['defer', 'ses_network']);
  });

  it('defers when SES does not answer in time', async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'TimeoutError'));
        });
      });
    const failure = await failureOf(
      createSesSender(config({ fetch: slow, timeoutMs: 20 })),
      'email.send:timeout-0000001',
    );
    expect(failure.code).toBe('ses_network');
  });

  it('is told by SES when the secret is wrong or the clock is far off', async () => {
    const wrongSecret = await failureOf(
      createSesSender(config({ secretAccessKey: 'another-secret' })),
      'email.send:wrong-secret-0001',
    );
    expect(wrongSecret.code).toBe('ses_credentials_rejected');
    const skewed = await failureOf(
      createSesSender(config({ now: () => new Date(Date.now() - 10 * 60_000) })),
      'email.send:clock-skew-000001',
    );
    expect(skewed.code).toBe('ses_credentials_rejected');
    const wrongRegion = await failureOf(
      createSesSender(config({ region: 'us-east-1' })),
      'email.send:wrong-region-0001',
    );
    expect(wrongRegion.code).toBe('ses_credentials_rejected');
  });

  it('refuses a recipient SES cannot take, before calling it', async () => {
    const before = ses.requests.length + ses.rejected.length;
    const sender = createSesSender(config());
    await expect(
      sender.send({ ...message('email.send:non-ascii-0000001'), to: 'jörg@shop.example' }),
    ).rejects.toMatchObject({ disposition: 'permanent', code: 'recipient_not_ascii' });
    expect(ses.requests.length + ses.rejected.length).toBe(before);
  });

  it('never puts the recipient, the subject or a body in an error', async () => {
    ses.failNext({ status: 400, type: 'MessageRejected' });
    const sender = createSesSender(config());
    const failure = await failureOf(sender, 'email.send:no-leaks-00000001');
    const shown = [failure.message, failure.code, String(failure.stack).split('\n')[0]].join(' ');
    expect(shown).not.toContain(RECIPIENT);
    expect(shown).not.toContain('shop.example');
    expect(JSON.stringify(failure)).not.toContain(RECIPIENT);
  });
});

describe('idempotency with a ledger', () => {
  it('sends a message key once', async () => {
    const sender = guardSender(withLedger(createSesSender(config()), new MemoryLedger()));
    const before = ses.requests.length;
    const first = await sender.send(message('email.send:once-000000000001'));
    const second = await sender.send(message('email.send:once-000000000001'));
    expect(first.status).toBe('sent');
    expect(second.status).toBe('duplicate');
    expect(ses.requests.length - before).toBe(1);
  });

  it('counts tries and sends again after a failure that was not permanent', async () => {
    const ledger = new MemoryLedger();
    const sender = withLedger(createSesSender(config()), ledger);
    ses.failNext(
      { status: 503, type: 'ServiceUnavailable' },
      { status: 429, type: 'TooManyRequestsException' },
    );
    const first = await failureOf(sender, 'email.send:retry-000000000001');
    const second = await failureOf(sender, 'email.send:retry-000000000001');
    expect([first.tries, second.tries]).toEqual([1, 2]);
    const third = await sender.send(message('email.send:retry-000000000001'));
    expect(third.status).toBe('sent');
    expect((await sender.send(message('email.send:retry-000000000001'))).status).toBe('duplicate');
  });
});

describe('configuration', () => {
  it.each([
    ['a region that is not one', { region: 'Europe' }],
    ['no access key', { accessKeyId: '' }],
    ['no secret', { secretAccessKey: '' }],
    ['a sender that is not an address', { from: 'Rampsmith' }],
    ['a display name with a quote', { from: '"Ramp"smith" <hello@rampsmith.example>' }],
    ['a plain-HTTP endpoint that is not loopback', { endpoint: 'http://ses.example' }],
  ])('refuses %s at startup', (_name, over) => {
    expect(() => createSesSender(config(over))).toThrow(SesConfigError);
  });

  it('accepts a bare address as the sender', async () => {
    const before = ses.requests.length;
    await createSesSender(config({ from: 'hello@rampsmith.example' })).send(
      message('email.send:bare-from-00000001'),
    );
    expect(ses.requests[before]?.body.FromEmailAddress).toBe('hello@rampsmith.example');
  });

  it('reads LAUNCH.md C row 7 from the environment, and names what is missing', () => {
    expect(sesConfigFromEnv({})).toEqual({
      missing: ['SES_REGION', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'EMAIL_FROM'],
    });
    expect(
      sesConfigFromEnv({
        SES_REGION: 'eu-west-1',
        SES_ACCESS_KEY_ID: 'a',
        SES_SECRET_ACCESS_KEY: 'b',
        EMAIL_FROM: 'x@rampsmith.example',
      }),
    ).toMatchObject({ region: 'eu-west-1', from: 'x@rampsmith.example' });
  });
});
