/**
 * The per-store AI budget on PostgreSQL (PLAN §13, ADR-214): `BudgetLedger` over the
 * `ai_budgets` and `ai_reservations` tables. Every operation is one transaction scoped to the
 * tenant, so row-level security applies, and the reservation is one conditional `UPDATE`, so
 * two engine processes can never both spend the last of a budget.
 */
import { randomUUID } from 'node:crypto';
import type { BudgetLedger, Reservation, ReserveRequest, ReserveResult } from '@rampsmith/ai';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';

function assertMicroUsd(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of micro-dollars`);
  }
}

/** A ledger for one tenant's job; `tenantId` is the job's tenant, never a payload value. */
export class PostgresBudgetLedger implements BudgetLedger {
  readonly #sql: postgres.Sql;
  readonly #tenantId: string;

  constructor(sql: postgres.Sql, tenantId: string) {
    this.#sql = sql;
    this.#tenantId = tenantId;
  }

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    assertMicroUsd('amountMicroUsd', request.amountMicroUsd);
    assertMicroUsd('limitMicroUsd', request.limitMicroUsd);
    if (request.tenantId !== this.#tenantId) {
      throw new RangeError('the ledger serves one tenant');
    }
    return withTenant(this.#sql, this.#tenantId, async (tx) => {
      await tx`
        insert into ai_budgets (tenant_id, period)
        values (${this.#tenantId}, ${request.period})
        on conflict (tenant_id, period) do nothing`;
      const held = await tx<{ spent: string; reserved: string }[]>`
        update ai_budgets
           set reserved_micro_usd = reserved_micro_usd + ${request.amountMicroUsd}
         where tenant_id = ${this.#tenantId} and period = ${request.period}
           and ${request.limitMicroUsd} > 0
           and spent_micro_usd + reserved_micro_usd + ${request.amountMicroUsd}
               <= ${request.limitMicroUsd}
        returning spent_micro_usd::text as spent, reserved_micro_usd::text as reserved`;
      if (held.length === 0) {
        const [now] = await tx<{ used: string }[]>`
          select (spent_micro_usd + reserved_micro_usd)::text as used from ai_budgets
           where tenant_id = ${this.#tenantId} and period = ${request.period}`;
        return {
          ok: false,
          usedMicroUsd: Number(now?.used ?? 0),
          limitMicroUsd: request.limitMicroUsd,
        } satisfies ReserveResult;
      }
      const id = randomUUID();
      await tx`
        insert into ai_reservations (id, tenant_id, period, amount_micro_usd, state)
        values (${id}, ${this.#tenantId}, ${request.period}, ${request.amountMicroUsd}, 'reserved')`;
      const reservation: Reservation = {
        id,
        tenantId: this.#tenantId,
        period: request.period,
        amountMicroUsd: request.amountMicroUsd,
      };
      return { ok: true, reservation } satisfies ReserveResult;
    });
  }

  async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    assertMicroUsd('actualMicroUsd', actualMicroUsd);
    await this.#close(reservationId, actualMicroUsd);
  }

  async release(reservationId: string): Promise<void> {
    await this.#close(reservationId, null);
  }

  /** Closes a held reservation; closing it again is a no-op, an unknown id is an error. */
  #close(reservationId: string, actual: number | null): Promise<void> {
    return withTenant(this.#sql, this.#tenantId, async (tx) => {
      const closed = await tx<{ period: string; amount: string }[]>`
        update ai_reservations
           set state = ${actual === null ? 'released' : 'settled'},
               actual_micro_usd = ${actual},
               closed_at = now()
         where id = ${reservationId} and tenant_id = ${this.#tenantId} and state = 'reserved'
        returning period, amount_micro_usd::text as amount`;
      const row = closed[0];
      if (row === undefined) {
        const known = await tx`
          select 1 from ai_reservations where id = ${reservationId} and tenant_id = ${this.#tenantId}`;
        if (known.length === 0) throw new Error('unknown reservation');
        return;
      }
      await tx`
        update ai_budgets
           set reserved_micro_usd = reserved_micro_usd - ${row.amount}::bigint,
               spent_micro_usd = spent_micro_usd + ${actual ?? 0}
         where tenant_id = ${this.#tenantId} and period = ${row.period}`;
    });
  }
}
