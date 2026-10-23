/**
 * AWS Signature Version 4 for a request without a query string (ADR-270). The Amazon SES
 * adapter is the only caller, so this signs what it needs and nothing more: no query string, no
 * chunked bodies, no presigned URLs. The algorithm is AWS's published one ("Signing AWS API requests"); the tests
 * check the output against AWS's own test-suite vector and against botocore's signer.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials only. */
  readonly sessionToken?: string | undefined;
}

export interface SigningRequest {
  readonly method: 'GET' | 'POST';
  /** The `Host` header value: host and, when it is not the scheme's default, `:port`. */
  readonly host: string;
  /** An absolute path with no query string, already percent-encoded where needed. */
  readonly path: string;
  readonly body: string;
  /** Sent and signed when set; a bodiless request has none. */
  readonly contentType?: string | undefined;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

/** `20150830T123600Z`: the request time in the form SigV4 signs. */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * The headers to send with `request`: everything SigV4 signed, plus the `Authorization` header.
 * `Host` is not returned because the HTTP client sets it from the URL; the signature covers the
 * value in `request.host`, which must equal it.
 */
export function signRequest(request: SigningRequest): Record<string, string> {
  const date = amzDate(request.now);
  const day = date.slice(0, 8);
  const signed: Record<string, string> = { host: request.host, 'x-amz-date': date };
  if (request.contentType !== undefined) {
    signed['content-type'] = request.contentType;
  }
  if (request.credentials.sessionToken !== undefined) {
    signed['x-amz-security-token'] = request.credentials.sessionToken;
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${(signed[name] ?? '').trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method,
    request.path,
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(request.body),
  ].join('\n');
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, day), request.region),
      request.service,
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  const sent: Record<string, string> = {};
  for (const name of names) {
    if (name !== 'host') sent[name] = signed[name] ?? '';
  }
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
