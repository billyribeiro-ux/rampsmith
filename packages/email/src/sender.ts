/**
 * The sending side (ADR-194). This package never calls a mail provider; the Amazon SES adapter
 * is written later against {@link EmailSender}. {@link guardSender} wraps any sender and
 * refuses a message that is not safe to send, so every adapter gets the same checks.
 */
import { isEmailAddress } from './links.ts';
import { RenderedEmail } from './render.ts';
import { hasLineBreak } from './sanitize.ts';

/** One message for one recipient. */
export interface OutboundEmail {
  /** A single plain address, no display name. Never logged. */
  readonly to: string;
  /**
   * Stable for the logical message (the `email.send` job's idempotency key, PLAN §10), so a
   * retried job never sends twice.
   */
  readonly idempotencyKey: string;
  readonly email: RenderedEmail;
}

export type SendReceipt =
  | { readonly status: 'sent'; readonly messageId: string }
  /** A message with this idempotency key was already sent; nothing was sent again. */
  | { readonly status: 'duplicate' };

/**
 * What a mail provider adapter implements. An implementation must:
 * - send `email.text` and `email.html` as `multipart/alternative`, with a transfer encoding
 *   (quoted-printable or base64), because a long paragraph can pass SMTP's 998-octet lines;
 * - use `email.subject` as the subject and add every entry of `email.headers` unchanged, and
 *   have its DKIM signature cover `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058);
 * - send from the configured sender (`EMAIL_FROM`), with no tracking pixel, open tracking or
 *   click tracking (SES configuration sets must leave both off);
 * - record `idempotencyKey` durably and return `duplicate` instead of sending twice;
 * - never log `to`, `email.subject`, `email.text`, `email.html` or `email.headers`.
 */
export interface EmailSender {
  send(message: OutboundEmail): Promise<SendReceipt>;
}

/** Why {@link guardSender} refused a message. */
export type RefusalReason =
  | 'not-rendered'
  | 'recipient-invalid'
  | 'idempotency-key-invalid'
  | 'header-invalid'
  | 'postal-address-missing'
  | 'unsubscribe-not-https';

export class SendRefusedError extends Error {
  readonly reasons: readonly RefusalReason[];

  constructor(reasons: readonly RefusalReason[]) {
    super(`email not sent: ${reasons.join(', ')}`);
    this.name = 'SendRefusedError';
    this.reasons = reasons;
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;

/**
 * Reads each field of `message` once into a frozen copy, so a getter or a later mutation
 * cannot show the checks one value and the provider another.
 */
function snapshot(message: OutboundEmail): OutboundEmail {
  const to: unknown = message.to;
  const idempotencyKey: unknown = message.idempotencyKey;
  const email: unknown = message.email;
  return Object.freeze({
    to: typeof to === 'string' ? to : '',
    idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : '',
    email: email as RenderedEmail,
  });
}

function reasonsFor(message: OutboundEmail): RefusalReason[] {
  if (!RenderedEmail.isRendered(message.email)) {
    return ['not-rendered'];
  }
  const reasons: RefusalReason[] = [];
  if (!isEmailAddress(message.to)) {
    reasons.push('recipient-invalid');
  }
  if (!IDEMPOTENCY_KEY.test(message.idempotencyKey)) {
    reasons.push('idempotency-key-invalid');
  }
  const headerProblem =
    hasLineBreak(message.email.subject) ||
    Object.entries(message.email.headers).some(
      ([name, value]) => !HEADER_NAME.test(name) || hasLineBreak(value),
    );
  if (headerProblem) {
    reasons.push('header-invalid');
  }
  reasons.push(...message.email.problems);
  return reasons;
}

/** Every reason `message` must not be sent; empty when it may be. */
export function checkOutbound(message: OutboundEmail): RefusalReason[] {
  return reasonsFor(snapshot(message));
}

/**
 * Wraps `inner` so that it only ever receives messages {@link checkOutbound} accepts. The inner
 * sender gets the frozen copy that was checked, never the caller's object.
 */
export function guardSender(inner: EmailSender): EmailSender {
  return {
    async send(message) {
      const checked = snapshot(message);
      const reasons = reasonsFor(checked);
      if (reasons.length > 0) {
        throw new SendRefusedError(reasons);
      }
      return inner.send(checked);
    },
  };
}

/** Fields of a message that are safe to log: no address, subject, body or link. */
export function describeForLog(message: OutboundEmail): Readonly<Record<string, string>> {
  return {
    kind: message.email.kind,
    category: message.email.category,
    lang: message.email.lang,
    idempotencyKey: message.idempotencyKey,
  };
}

/**
 * An in-memory sender for tests and local development. It keeps every accepted message and
 * honours idempotency keys the way a real adapter must.
 */
export class MemorySender implements EmailSender {
  readonly #sent: OutboundEmail[] = [];
  readonly #keys = new Set<string>();

  get sent(): readonly OutboundEmail[] {
    return this.#sent;
  }

  send(message: OutboundEmail): Promise<SendReceipt> {
    if (this.#keys.has(message.idempotencyKey)) {
      return Promise.resolve({ status: 'duplicate' });
    }
    this.#keys.add(message.idempotencyKey);
    this.#sent.push(message);
    return Promise.resolve({ status: 'sent', messageId: `memory-${String(this.#sent.length)}` });
  }
}
