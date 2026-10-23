/**
 * The sender's idempotency record in PostgreSQL (`email_deliveries`, ADR-271). Each call is its
 * own short transaction: the ledger must say `sending` before SES is called and `sent` after,
 * and neither may wait for the job.
 */
import type { IdempotencyLedger, LedgerClaim } from '@rampsmith/email';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';
import type { OPTED_OUT, SuppressionReason } from './suppression.ts';

/**
 * How long a `sending` row with no outcome counts as an attempt in flight: SES's request timeout
 * (15 seconds, `packages/email/src/ses.ts`) plus a margin for the database round trips.
 */
const IN_FLIGHT_SECONDS = 60;

export class PgLedger implements IdempotencyLedger {
  readonly #sql: postgres.Sql;
  readonly #tenantId: string;
  readonly #template: string;

  constructor(sql: postgres.Sql, tenantId: string, template: string) {
    this.#sql = sql;
    this.#tenantId = tenantId;
    this.#template = template;
  }

  /**
   * Claims `key`: the first claim inserts the row, a later one counts another try. A key already
   * `sent` (or `suppressed`) is not claimed, so the caller reports a duplicate.
   *
   * A `sending` row with no error code is an attempt that has not recorded an outcome. While it
   * is younger than {@link IN_FLIGHT_SECONDS} (the SES timeout and a margin) it may still be
   * talking to SES, so the key is not claimed again and the caller defers (audit L2). An older
   * one belonged to a process that died, and a `sending` row that has an error code is a retry
   * waiting for its turn (`failed`), so both are claimed.
   */
  begin(key: string): Promise<LedgerClaim> {
    return withTenant(this.#sql, this.#tenantId, async (tx) => {
      const [row] = await tx<{ tries: number }[]>`
        insert into email_deliveries (tenant_id, message_key, template, state, tries)
        values (${this.#tenantId}, ${key}, ${this.#template}, 'sending', 1)
        on conflict (tenant_id, message_key) do update
           set tries = email_deliveries.tries + 1, state = 'sending',
               error_code = null, updated_at = now()
         where email_deliveries.state = 'failed'
            or (email_deliveries.state = 'sending'
                and (email_deliveries.error_code is not null
                     or email_deliveries.updated_at
                        < now() - make_interval(secs => ${IN_FLIGHT_SECONDS})))
        returning tries`;
      if (row !== undefined) return { status: 'claimed', tries: row.tries } as const;
      const [held] = await tx<{ state: string; age: number }[]>`
        select state, extract(epoch from now() - updated_at)::float8 as age
          from email_deliveries
         where tenant_id = ${this.#tenantId} and message_key = ${key}`;
      if (held?.state === 'sending') {
        const wait = Math.ceil((IN_FLIGHT_SECONDS - held.age) * 1000);
        return { status: 'in_flight', retryAfterMs: Math.max(1000, wait) } as const;
      }
      return { status: 'duplicate' } as const;
    });
  }

  async sent(key: string, messageId: string): Promise<void> {
    await withTenant(this.#sql, this.#tenantId, async (tx) => {
      await tx`
        update email_deliveries
           set state = 'sent', message_id = ${messageId.slice(0, 200)}, error_code = null,
               updated_at = now()
         where tenant_id = ${this.#tenantId} and message_key = ${key}`;
    });
  }

  async failed(key: string, code: string, permanent: boolean): Promise<void> {
    await withTenant(this.#sql, this.#tenantId, async (tx) => {
      await tx`
        update email_deliveries
           set state = ${permanent ? 'failed' : 'sending'}, error_code = ${code.slice(0, 60)},
               updated_at = now()
         where tenant_id = ${this.#tenantId} and message_key = ${key}`;
    });
  }

  /** Records that the message was not sent because the recipient is on the suppression list or switched the category off. */
  async suppressed(key: string, reason: SuppressionReason | typeof OPTED_OUT): Promise<void> {
    await withTenant(this.#sql, this.#tenantId, async (tx) => {
      // A retry that was waiting (`sending` with a code, or `failed`) becomes `suppressed` too,
      // so no row is left saying a message may still go out (audit L2); `sent` is never undone.
      await tx`
        insert into email_deliveries (tenant_id, message_key, template, state, error_code)
        values (${this.#tenantId}, ${key}, ${this.#template}, 'suppressed',
                ${`suppressed_${reason}`})
        on conflict (tenant_id, message_key) do update
           set state = 'suppressed', error_code = ${`suppressed_${reason}`}, updated_at = now()
         where email_deliveries.state in ('sending', 'failed')`;
    });
  }
}
