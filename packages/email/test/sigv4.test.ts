import { describe, expect, it } from 'vitest';
import { amzDate, signRequest } from '../src/sigv4.ts';

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const WHEN = new Date('2015-08-30T12:36:00Z');
const BODY = '{"Content":{"Simple":{"Body":{"Text":{"Data":"hi"}},"Subject":{"Data":"s"}}}}';

describe('SigV4 signer (ADR-270)', () => {
  it('writes the request time the way SigV4 signs it', () => {
    expect(amzDate(WHEN)).toBe('20150830T123600Z');
    expect(amzDate(new Date('2026-10-22T07:08:09.999Z'))).toBe('20261022T070809Z');
  });

  it('matches AWS’s published test-suite vector "get-vanilla"', () => {
    // aws-sig-v4-test-suite/get-vanilla: GET / with only Host and X-Amz-Date, service "service".
    const headers = signRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: CREDENTIALS,
      now: WHEN,
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers).not.toHaveProperty('host');
  });

  // Expected values: botocore 1.43.118's SigV4Auth on the same request and time (the Python
  // script is recorded in docs/evidence/email-sender.md).
  it('matches botocore for a SES SendEmail request', () => {
    const headers = signRequest({
      method: 'POST',
      host: 'email.eu-west-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      body: BODY,
      contentType: 'application/json',
      region: 'eu-west-1',
      service: 'ses',
      credentials: CREDENTIALS,
      now: WHEN,
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-west-1/ses/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=053b4915d784b628aa14fb7c8c6b8c8275745923311880fb2f5ce658469769a1',
    );
    expect(headers['content-type']).toBe('application/json');
  });

  it('signs a session token as botocore does', () => {
    const headers = signRequest({
      method: 'POST',
      host: 'email.eu-west-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      body: BODY,
      contentType: 'application/json',
      region: 'eu-west-1',
      service: 'ses',
      credentials: { ...CREDENTIALS, sessionToken: 'SESSIONTOKEN' },
      now: WHEN,
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-west-1/ses/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, ' +
        'Signature=8fdb50c745f994259aa57bb6fe156966cd0226920a5b2e3d99888e3002136678',
    );
    expect(headers['x-amz-security-token']).toBe('SESSIONTOKEN');
  });

  it('changes the signature with the body, the key, the region and the time', () => {
    const base = {
      method: 'POST' as const,
      host: 'email.eu-west-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      body: BODY,
      contentType: 'application/json',
      region: 'eu-west-1',
      service: 'ses',
      credentials: CREDENTIALS,
      now: WHEN,
    };
    const signature = (over: Partial<typeof base>): string | undefined =>
      signRequest({ ...base, ...over })['authorization']?.split('Signature=')[1];
    const reference = signature({});
    expect(signature({ body: `${BODY} ` })).not.toBe(reference);
    expect(signature({ region: 'us-east-1' })).not.toBe(reference);
    expect(signature({ now: new Date(WHEN.getTime() + 1000) })).not.toBe(reference);
    expect(
      signature({ credentials: { ...CREDENTIALS, secretAccessKey: 'another-secret' } }),
    ).not.toBe(reference);
  });
});
