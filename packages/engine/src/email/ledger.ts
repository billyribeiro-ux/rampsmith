/**
 * The sender's idempotency record in PostgreSQL (`email_deliveries`, ADR-271). Each call is its
 * own short transaction: the ledger must say `sending` before SES is called and `sent` after,
 * and neither may wait for the job.
 */
import type { IdempotencyLedger, LedgerClaim } from '@rampsmith/email';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';
import type { OPTED_OUT, SuppressionReason } from './suppression.ts';

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
   */
  begin(key: string): Promise<LedgerClaim> {
    return withTenant(this.#sql, this.#tenantId, async (tx) => {
      const [row] = await tx<{ tries: number }[]>`
        insert into email_deliveries (tenant_id, message_key, template, state, tries)
        values (${this.#tenantId}, ${key}, ${this.#template}, 'sending', 1)
        on conflict (tenant_id, message_key) do update
           set tries = email_deliveries.tries + 1, state = 'sending',
               error_code = null, updated_at = now()
         where email_deliveries.state in ('sending', 'failed')
        returning tries`;
      return row === undefined
        ? ({ status: 'duplicate' } as const)
        : ({ status: 'claimed', tries: row.tries } as const);
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
      await tx`
        insert into email_deliveries (tenant_id, message_key, template, state, error_code)
        values (${this.#tenantId}, ${key}, ${this.#template}, 'suppressed',
                ${`suppressed_${reason}`})
        on conflict (tenant_id, message_key) do nothing`;
    });
  }
}
