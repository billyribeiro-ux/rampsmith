/**
 * The Amazon SES adapter for {@link EmailSender} (ADR-194, ADR-270): one `SendEmail` call of the
 * SES v2 API per message, signed with SigV4 by `sigv4.ts`, with no SDK. It is the transport
 * only; the durable idempotency record is `withLedger` (ledger.ts).
 *
 * API facts used, from the SES v2 API reference and AWS's service model (2019-09-27):
 * `POST /v2/email/outbound-emails`, service name `ses`, a JSON body, `MessageId` in the answer;
 * `Content.Simple` carries a subject, a text and an HTML body (SES assembles the MIME message)
 * and a list of extra headers; `ConfigurationOverrides.Tracking` turns open and click tracking
 * off for the one message. Errors arrive as an HTTP status plus the `x-amzn-ErrorType` header.
 *
 * Nothing here logs. Errors carry a stable code and never AWS's message text, which can quote
 * the recipient (ADR-194).
 */
import { isSimpleAddress } from './links.ts';
import { signRequest, type AwsCredentials } from './sigv4.ts';
import { SendFailure, type EmailSender, type OutboundEmail, type SendReceipt } from './sender.ts';

export interface SesConfig extends AwsCredentials {
  /** An AWS region name such as `eu-west-1` (LAUNCH.md C row 7: `SES_REGION`). */
  readonly region: string;
  /** `EMAIL_FROM`: `name@example.com` or `Name <name@example.com>`. */
  readonly from: string;
  /** Tests only: the base URL of a stand-in for SES. HTTPS, or HTTP on a loopback host. */
  readonly endpoint?: string | undefined;
  /** Tests only. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  /** Milliseconds to wait for SES; 15 seconds when absent. */
  readonly timeoutMs?: number | undefined;
}

export class SesConfigError extends Error {
  constructor(message: string) {
    super(`ses: ${message}`);
    this.name = 'SesConfigError';
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u;
const DISPLAY_NAME = /^[ -~]{1,70}$/u;
const SENDING_PATH = '/v2/email/outbound-emails';
const SERVICE = 'ses';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Every SES error type the API reference lists for `SendEmail`, and what to do about it. */
const BY_TYPE: Readonly<
  Record<string, { disposition: 'defer' | 'permanent'; code: string; waitMs?: number }>
> = {
  TooManyRequestsException: { disposition: 'defer', code: 'ses_throttled' },
  LimitExceededException: { disposition: 'defer', code: 'ses_quota_exceeded', waitMs: 1_800_000 },
  SendingPausedException: { disposition: 'defer', code: 'ses_sending_paused', waitMs: 1_800_000 },
  MailFromDomainNotVerifiedException: {
    disposition: 'defer',
    code: 'ses_sender_not_verified',
    waitMs: 900_000,
  },
  AccountSuspendedException: { disposition: 'permanent', code: 'ses_account_suspended' },
  MessageRejected: { disposition: 'permanent', code: 'ses_message_rejected' },
  BadRequestException: { disposition: 'permanent', code: 'ses_bad_request' },
  NotFoundException: { disposition: 'permanent', code: 'ses_not_found' },
};

/** Longest wait a `Retry-After` header can ask for; the queue caps a deferral at 35 days anyway. */
const MAX_RETRY_AFTER_MS = 3_600_000;

/** Where an email address stands in `EMAIL_FROM`, split into display name and address. */
function parseFrom(from: string): { display: string | null; address: string } {
  const match = /^\s*(?:(.*?)\s*<([^<>]+)>|([^<>\s]+))\s*$/u.exec(from);
  const address = (match?.[2] ?? match?.[3] ?? '').trim();
  const display = (match?.[1] ?? '').trim().replace(/^"(.*)"$/u, '$1');
  if (!isSimpleAddress(address)) {
    throw new SesConfigError('EMAIL_FROM must hold an address such as name@example.com');
  }
  if (display !== '' && (!DISPLAY_NAME.test(display) || /["<>\\]/u.test(display))) {
    throw new SesConfigError(
      'the display name in EMAIL_FROM must be plain ASCII without quotes or angle brackets',
    );
  }
  return { display: display === '' ? null : display, address };
}

/** `Name <address>` or the bare address, in the form SES accepts for `FromEmailAddress`. */
function fromHeader(from: string): string {
  const { display, address } = parseFrom(from);
  return display === null ? address : `${display} <${address}>`;
}

/** A subject in 7-bit ASCII: RFC 2047 encoded-words when it has other characters. */
export function encodeSubject(subject: string): string {
  if (/^[ -~]*$/u.test(subject)) {
    return subject;
  }
  const words: string[] = [];
  let chunk = '';
  const flush = (): void => {
    if (chunk !== '') {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
    }
  };
  for (const character of subject) {
    // 45 bytes encode to 60 base64 characters, so each word stays under RFC 2047's 75.
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) flush();
    chunk += character;
  }
  flush();
  return words.join(' ');
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
}

/** `TooManyRequestsException:http://internal.amazon.com/...` or `com.amazon#Name` to `Name`. */
function errorType(header: string | null, body: unknown): string {
  let raw = header ?? '';
  if (raw === '' && typeof body === 'object' && body !== null) {
    const typed = (body as Record<string, unknown>)['__type'];
    if (typeof typed === 'string') raw = typed;
  }
  return raw.split(':')[0]?.split('#').pop()?.trim() ?? '';
}

/** What a non-200 answer means. Exported for the tests of the mapping. */
export function failureFor(status: number, type: string, retryAfter: string | null): SendFailure {
  const known = BY_TYPE[type];
  const wait = retryAfterMs(retryAfter);
  const message = `Amazon SES refused the message (HTTP ${String(status)}${type === '' ? '' : `, ${type}`})`;
  if (known !== undefined) {
    return new SendFailure(known.disposition, known.code, message, wait ?? known.waitMs);
  }
  if (status === 429) {
    return new SendFailure('defer', 'ses_throttled', message, wait);
  }
  if (status === 401 || status === 403) {
    // Wrong or expired keys, a missing permission, a clock far off: a person fixes these.
    return new SendFailure('defer', 'ses_credentials_rejected', message, wait ?? 900_000);
  }
  if (status >= 500) {
    return new SendFailure('defer', 'ses_unavailable', message, wait);
  }
  return new SendFailure('permanent', 'ses_request_refused', message);
}

function endpointFor(config: SesConfig): URL {
  if (config.endpoint === undefined) {
    return new URL(`https://email.${config.region}.amazonaws.com`);
  }
  const url = new URL(config.endpoint);
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new SesConfigError('the endpoint must be HTTPS (HTTP only on a loopback host)');
  }
  return url;
}

/**
 * Creates the SES transport. Settings are checked here, so a bad region or sender fails at
 * startup and not when an email is due.
 */
export function createSesSender(config: SesConfig): EmailSender {
  if (!REGION.test(config.region)) {
    throw new SesConfigError('SES_REGION is not an AWS region name such as eu-west-1');
  }
  if (config.accessKeyId === '' || config.secretAccessKey === '') {
    throw new SesConfigError('SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY must be set');
  }
  const from = fromHeader(config.from);
  const endpoint = endpointFor(config);
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? 15_000;
  const credentials: AwsCredentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  };

  return {
    async send(message: OutboundEmail): Promise<SendReceipt> {
      const { email } = message;
      if (!/^[!-~]+$/u.test(message.to)) {
        throw new SendFailure(
          'permanent',
          'recipient_not_ascii',
          'SES takes only 7-bit ASCII in the local part (and Punycode in the domain)',
        );
      }
      const headers = Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value }));
      for (const { Name, Value } of headers) {
        if (
          !/^[!-9;-@A-~]{1,126}$/u.test(Name) ||
          !/^[ -~]{1,995}$/u.test(Value) ||
          Name.length + Value.length > 996
        ) {
          throw new SendFailure('permanent', 'header_not_accepted', 'a header does not fit SES');
        }
      }
      const body = JSON.stringify({
        FromEmailAddress: from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: encodeSubject(email.subject), Charset: 'UTF-8' },
            Body: {
              Text: { Data: email.text, Charset: 'UTF-8' },
              Html: { Data: email.html, Charset: 'UTF-8' },
            },
            ...(headers.length > 0 ? { Headers: headers } : {}),
          },
        },
        // Per message, so neither the account nor a configuration set can switch it on (ADR-191).
        ConfigurationOverrides: {
          Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' },
        },
      });
      const signed = signRequest({
        method: 'POST',
        host: endpoint.host,
        path: SENDING_PATH,
        body,
        contentType: 'application/json',
        region: config.region,
        service: SERVICE,
        credentials,
        now: now(),
      });

      let response: Response;
      try {
        response = await doFetch(new URL(SENDING_PATH, endpoint), {
          method: 'POST',
          headers: { ...signed, accept: 'application/json' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // The cause can name the host and the request; the code is all a caller needs.
        throw new SendFailure('defer', 'ses_network', 'Amazon SES could not be reached');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      if (response.status === 200) {
        const id =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['MessageId']
            : undefined;
        // SES accepted the message: even without an id it must not be sent again.
        return { status: 'sent', messageId: typeof id === 'string' && id !== '' ? id : 'unknown' };
      }
      throw failureFor(
        response.status,
        errorType(response.headers.get('x-amzn-errortype'), parsed),
        response.headers.get('retry-after'),
      );
    },
  };
}

/** The settings of LAUNCH.md C row 7 from a process environment, or the names that are missing. */
export function sesConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SesConfig | { readonly missing: readonly string[] } {
  const names = ['SES_REGION', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'EMAIL_FROM'] as const;
  const missing = names.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    return { missing };
  }
  return {
    region: (env['SES_REGION'] ?? '').trim(),
    accessKeyId: (env['SES_ACCESS_KEY_ID'] ?? '').trim(),
    secretAccessKey: (env['SES_SECRET_ACCESS_KEY'] ?? '').trim(),
    from: (env['EMAIL_FROM'] ?? '').trim(),
    ...((env['SES_SESSION_TOKEN'] ?? '') === ''
      ? {}
      : { sessionToken: (env['SES_SESSION_TOKEN'] ?? '').trim() }),
  };
}
