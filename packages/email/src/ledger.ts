/**
 * The durable half of {@link EmailSender}'s idempotency rule (ADR-194, ADR-271). Amazon SES has
 * no idempotency token on `SendEmail`, so the caller records each message's key before sending
 * and again after: {@link withLedger} wraps any transport with that protocol, and the engine
 * supplies a PostgreSQL ledger. The protocol is at-least-once: a process that dies between the
 * provider accepting a message and `sent` being recorded sends it again on the retry.
 */
import { SendFailure, type EmailSender, type OutboundEmail, type SendReceipt } from './sender.ts';

export type LedgerClaim =
  /** Go ahead. `tries` counts this send, so the first is 1. */
  | { readonly status: 'claimed'; readonly tries: number }
  /** A message with this key was already sent. */
  | { readonly status: 'duplicate' }
  /**
   * Another attempt claimed this key a moment ago and has not recorded an outcome, so a second
   * send now could deliver the message twice. Try again after `retryAfterMs`.
   */
  | { readonly status: 'in_flight'; readonly retryAfterMs: number };

export interface IdempotencyLedger {
  begin(key: string): Promise<LedgerClaim>;
  sent(key: string, messageId: string): Promise<void>;
  failed(key: string, code: string, permanent: boolean): Promise<void>;
}

/** Wraps `transport` so a message key is sent at most once, as far as a ledger can tell. */
export function withLedger(transport: EmailSender, ledger: IdempotencyLedger): EmailSender {
  return {
    async send(message: OutboundEmail): Promise<SendReceipt> {
      const claim = await ledger.begin(message.idempotencyKey);
      if (claim.status === 'duplicate') {
        return { status: 'duplicate' };
      }
      if (claim.status === 'in_flight') {
        throw new SendFailure(
          'defer',
          'email_in_flight',
          'another attempt at this message is in flight',
          claim.retryAfterMs,
        );
      }
      let receipt: SendReceipt;
      try {
        receipt = await transport.send(message);
      } catch (error) {
        if (error instanceof SendFailure) {
          error.tries = claim.tries;
          await ledger.failed(
            message.idempotencyKey,
            error.code,
            error.disposition === 'permanent',
          );
        }
        throw error;
      }
      if (receipt.status === 'sent') {
        await ledger.sent(message.idempotencyKey, receipt.messageId);
      }
      return receipt;
    },
  };
}

/** A ledger in memory, for tests and local development. */
export class MemoryLedger implements IdempotencyLedger {
  readonly #entries = new Map<string, { tries: number; sent: boolean }>();

  begin(key: string): Promise<LedgerClaim> {
    const entry = this.#entries.get(key) ?? { tries: 0, sent: false };
    if (entry.sent) {
      return Promise.resolve({ status: 'duplicate' });
    }
    entry.tries += 1;
    this.#entries.set(key, entry);
    return Promise.resolve({ status: 'claimed', tries: entry.tries });
  }

  sent(key: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry !== undefined) entry.sent = true;
    return Promise.resolve();
  }

  failed(): Promise<void> {
    return Promise.resolve();
  }
}
