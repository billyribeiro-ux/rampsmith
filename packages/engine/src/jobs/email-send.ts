/**
 * The `email.send@1` job (ADR-194, ADR-270 to ADR-273): resolve the recipient inside the job's
 * tenant, honour the tenant's suppression list, render the template with `@rampsmith/email`,
 * and send it through Amazon SES with a durable idempotency record.
 *
 * The job logs nothing. The recipient's address, the subject and the bodies exist only in this
 * function's locals and in the request to SES; every error it throws carries a stable code and
 * words that name settings and fields, never values.
 */
import { JobFailure, retryDelayMs } from '@rampsmith/queue';
import {
  categoryOf,
  guardSender,
  InputError,
  isEmailKind,
  SendFailure,
  SendRefusedError,
  withLedger,
} from '@rampsmith/email';
import type postgres from 'postgres';
import { PgLedger } from '../email/ledger.ts';
import { resolveRecipient } from '../email/recipient.ts';
import type { EmailRuntime } from '../email/runtime.ts';
import { blocks } from '../email/suppression.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

export interface EmailDeps {
  readonly sql: postgres.Sql;
  /** Absent in tests that serve every queue but send no mail. */
  readonly email?: EmailRuntime | undefined;
  /** A uniform sample in [0, 1) for the retry delay's jitter; `Math.random` when absent. */
  readonly random?: (() => number) | undefined;
}

/**
 * Sends of one message before the job gives up. With the queue's one-hour cap on delays this
 * spans about half a day of SES outages, throttling and fixable configuration, which is longer
 * than any email here stays useful and shorter than the 48 hours the uninstall export link lives.
 */
export const MAX_SEND_TRIES = 24;

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

export function emailSendHandler(deps: EmailDeps): JobHandler {
  const random = deps.random ?? Math.random;
  return async (job) => {
    const payload = parsePayload(job, 'email.send@1');
    const tenantId = requireTenant(job);
    const kind = payload.template;
    if (!isEmailKind(kind)) {
      // The schema lists the kinds, and a test pins the lists together; this is the backstop.
      throw permanent('email_kind_unknown', 'the template is not one @rampsmith/email renders');
    }
    const runtime = deps.email;
    if (runtime?.renderer === undefined || runtime.transport === undefined) {
      // A person fixes settings; the queue's backoff gives them hours before the job is dead.
      throw new JobFailure('retryable', {
        code: 'email_not_configured',
        message: (runtime?.problems ?? ['the engine was started without email']).join('; '),
      });
    }

    try {
      const recipient = await resolveRecipient(deps.sql, tenantId, payload.recipient);
      if (recipient === undefined) {
        throw permanent('recipient_missing', 'the recipient does not exist for this tenant');
      }
      const ledger = new PgLedger(deps.sql, tenantId, kind);
      if (recipient.suppression !== null && blocks(recipient.suppression, categoryOf(kind))) {
        await ledger.suppressed(payload.message_key, recipient.suppression);
        return;
      }

      let email;
      try {
        email = runtime.renderer.renderUnknown(kind, payload.input);
      } catch (error) {
        if (error instanceof InputError) {
          // The path names the field; the reason says what is wrong with it. Neither holds the value.
          throw permanent(
            'email_input_invalid',
            `the input does not fit ${kind}: ${error.message}`,
          );
        }
        throw error;
      }

      const sender = guardSender(withLedger(runtime.transport, ledger));
      await sender.send({
        to: recipient.address,
        idempotencyKey: payload.message_key,
        email,
      });
    } catch (error) {
      throw failureFor(error, random);
    }
  };
}

/** The job failure for whatever went wrong, without the cause's message when it is not ours. */
function failureFor(error: unknown, random: () => number): JobFailure {
  if (error instanceof JobFailure) return error;
  if (error instanceof SendRefusedError) {
    return permanent('send_refused', error.message);
  }
  if (error instanceof SendFailure) {
    if (error.disposition === 'permanent') {
      return permanent(error.code, error.message);
    }
    const tries = error.tries ?? 1;
    if (tries >= MAX_SEND_TRIES) {
      return permanent('email_gave_up', `${error.code} on each of ${String(tries)} tries`);
    }
    return new JobFailure(
      'defer',
      { code: error.code, message: error.message },
      { delayMs: Math.max(error.retryAfterMs ?? 0, retryDelayMs(tries, random())) },
    );
  }
  // A database error can quote a row, which here could be an address: keep only its class.
  const name = error instanceof Error ? error.name : 'unknown';
  return new JobFailure('retryable', {
    code: 'email_internal',
    message: `unexpected ${name} while sending (details withheld: they can name a recipient)`,
  });
}
