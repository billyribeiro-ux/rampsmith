/**
 * A stand-in for the Amazon SES v2 `SendEmail` endpoint, for tests (ADR-270). It is not a mock of
 * the adapter: it is a server that checks what AWS would check, so a request the adapter gets
 * wrong fails here the way it would fail there.
 *
 * It verifies the SigV4 signature (it recomputes it from the request it received, with its own
 * code, not the adapter's), the credential scope, the clock skew, the content type and the shape
 * of the JSON body, including the header limits and the per-message tracking switches. It can
 * also answer with any AWS error, to test the adapter's error mapping.
 */
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSesOptions {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The clock the signature's date is compared with. */
  readonly now?: () => Date;
}

/** One request the fake accepted as correctly formed and signed. */
export interface FakeSesRequest {
  readonly body: {
    readonly FromEmailAddress: string;
    readonly Destination: { readonly ToAddresses: readonly string[] };
    /** `SendEmailRequest.ConfigurationSetName` (botocore `sesv2` 2019-09-27). */
    readonly ConfigurationSetName?: string;
    readonly Content: {
      readonly Simple: {
        readonly Subject: { readonly Data: string; readonly Charset?: string };
        readonly Body: {
          readonly Text?: { readonly Data: string };
          readonly Html?: { readonly Data: string };
        };
        readonly Headers?: readonly { readonly Name: string; readonly Value: string }[];
        /** The shape of the SES v2 `Attachment` structure (botocore `sesv2` 2019-09-27). */
        readonly Attachments?: readonly {
          readonly RawContent: string;
          readonly FileName: string;
          readonly ContentType?: string;
          readonly ContentDisposition?: string;
          readonly ContentTransferEncoding?: string;
        }[];
      };
    };
    readonly ConfigurationOverrides?: {
      readonly Tracking?: {
        readonly OpenTrackingEnabled?: string;
        readonly ClickTrackingEnabled?: string;
      };
    };
  };
  readonly signedHeaders: readonly string[];
}

/** What the fake answers with instead of accepting the message. */
export interface FakeSesFailure {
  readonly status: number;
  /** The `x-amzn-ErrorType` value, such as `TooManyRequestsException`. */
  readonly type?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Close the connection without an answer. */
  readonly drop?: boolean;
}

export interface FakeSes {
  readonly endpoint: string;
  /** Every request that arrived signed correctly and well formed. */
  readonly requests: readonly FakeSesRequest[];
  /** Every request that did not: the status the fake answered with. */
  readonly rejected: readonly number[];
  /** The next requests are answered with these, in order, before any is accepted. */
  failNext(...failures: FakeSesFailure[]): void;
  close(): Promise<void>;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** `null` when the signature is right, otherwise the AWS error type the fake answers with. */
function verifySignature(
  request: IncomingMessage,
  body: string,
  options: FakeSesOptions,
  signedHeaders: string[],
): string | null {
  const authorization = header(request, 'authorization');
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/u.exec(
      authorization,
    );
  if (match === null) return 'IncompleteSignature';
  const [, accessKeyId, day, region, service, signedList, signature] = match;
  if (
    accessKeyId === undefined ||
    day === undefined ||
    region === undefined ||
    service === undefined ||
    signedList === undefined
  ) {
    return 'IncompleteSignature';
  }
  if (accessKeyId !== options.accessKeyId) return 'UnrecognizedClientException';
  if (region !== options.region || service !== 'ses') return 'InvalidSignatureException';
  const amzDate = header(request, 'x-amz-date');
  if (!/^\d{8}T\d{6}Z$/u.test(amzDate) || amzDate.slice(0, 8) !== day) {
    return 'InvalidSignatureException';
  }
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  const skew = Math.abs((options.now?.() ?? new Date()).getTime() - Date.parse(iso));
  if (skew > 5 * 60_000) return 'InvalidSignatureException';
  const names = signedList.split(';');
  if (!names.includes('host') || !names.includes('x-amz-date')) return 'IncompleteSignature';
  signedHeaders.push(...names);
  const canonicalHeaders = names
    .map((name) => `${name}:${header(request, name).trim()}\n`)
    .join('');
  const canonicalRequest = [
    request.method ?? '',
    (request.url ?? '').split('?')[0] ?? '',
    '',
    canonicalHeaders,
    signedList,
    sha256Hex(body),
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, day), region), service),
    'aws4_request',
  );
  const expected = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return expected === signature ? null : 'SignatureDoesNotMatch';
}

type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const PRINTABLE = /^[ -~]*$/u;

/** `null` when the body is one SES would accept, otherwise a short reason. */
function checkBody(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'body is not an object';
  const body = value as DeepPartial<FakeSesRequest['body']>;
  const to = body.Destination?.ToAddresses;
  if (typeof body.FromEmailAddress !== 'string' || body.FromEmailAddress === '') return 'no From';
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') return 'one To';
  if (
    body.ConfigurationSetName !== undefined &&
    !/^[A-Za-z0-9_-]{1,64}$/u.test(body.ConfigurationSetName)
  ) {
    return 'ConfigurationSetName';
  }
  const simple = body.Content?.Simple;
  if (simple === undefined) return 'no Content.Simple';
  if (typeof simple.Subject?.Data !== 'string' || !PRINTABLE.test(simple.Subject.Data)) {
    return 'the subject must be 7-bit ASCII';
  }
  if (typeof simple.Body?.Text?.Data !== 'string' || typeof simple.Body.Html?.Data !== 'string') {
    return 'text and html bodies';
  }
  for (const h of simple.Headers ?? []) {
    const name = h.Name ?? '';
    const value = h.Value ?? '';
    if (!/^[!-9;-@A-~]{1,126}$/u.test(name)) return 'header name';
    if (!/^[ -~]{1,995}$/u.test(value) || name.length + value.length > 996) {
      return 'header value';
    }
  }
  for (const a of simple.Attachments ?? []) {
    // Limits and enums from the service model: FileName <= 255, ContentType 1..78.
    if (typeof a.FileName !== 'string' || a.FileName === '' || a.FileName.length > 255) {
      return 'attachment FileName';
    }
    if (a.ContentType !== undefined && (a.ContentType === '' || a.ContentType.length > 78)) {
      return 'attachment ContentType';
    }
    if (
      a.ContentDisposition !== undefined &&
      a.ContentDisposition !== 'ATTACHMENT' &&
      a.ContentDisposition !== 'INLINE'
    ) {
      return 'attachment ContentDisposition';
    }
    if (
      a.ContentTransferEncoding !== undefined &&
      !['BASE64', 'QUOTED_PRINTABLE', 'SEVEN_BIT'].includes(a.ContentTransferEncoding)
    ) {
      return 'attachment ContentTransferEncoding';
    }
    // A blob travels as base64 over the JSON interface.
    if (typeof a.RawContent !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(a.RawContent)) {
      return 'attachment RawContent is not base64';
    }
  }
  return null;
}

export async function startFakeSes(options: FakeSesOptions): Promise<FakeSes> {
  const requests: FakeSesRequest[] = [];
  const rejected: number[] = [];
  const failures: FakeSesFailure[] = [];
  let counter = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      const answer = (status: number, type: string | null, json: unknown): void => {
        if (status !== 200) rejected.push(status);
        response.writeHead(status, {
          'content-type': 'application/json',
          ...(type === null ? {} : { 'x-amzn-errortype': type }),
        });
        response.end(JSON.stringify(json));
      };
      const scripted = failures.shift();
      if (scripted?.drop === true) {
        request.socket.destroy();
        return;
      }
      if (scripted !== undefined) {
        response.writeHead(scripted.status, {
          'content-type': 'application/json',
          ...(scripted.type === undefined ? {} : { 'x-amzn-errortype': scripted.type }),
          ...scripted.headers,
        });
        rejected.push(scripted.status);
        response.end(JSON.stringify({ message: 'scripted failure for a test' }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v2/email/outbound-emails') {
        answer(404, 'NotFoundException', { message: 'no such operation' });
        return;
      }
      if (header(request, 'content-type') !== 'application/json') {
        answer(415, 'UnsupportedMediaType', { message: 'application/json only' });
        return;
      }
      const signedHeaders: string[] = [];
      const bad = verifySignature(request, raw, options, signedHeaders);
      if (bad !== null) {
        answer(403, bad, { message: 'the signature was not accepted' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        answer(400, 'BadRequestException', { message: 'not JSON' });
        return;
      }
      const problem = checkBody(parsed);
      if (problem !== null) {
        answer(400, 'BadRequestException', { message: problem });
        return;
      }
      requests.push({ body: parsed as FakeSesRequest['body'], signedHeaders });
      counter += 1;
      answer(200, null, { MessageId: `fake-ses-${String(counter).padStart(4, '0')}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    requests,
    rejected,
    failNext(...next) {
      failures.push(...next);
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
