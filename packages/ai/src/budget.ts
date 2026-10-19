/**
 * The per-store monthly AI budget, enforced before a call is made (PLAN §13; ADR-214).
 *
 * Before each call the worst case (every input token at the dearest input price, every
 * allowed output token) is reserved against the tenant's limit for the UTC month; after the
 * call the reservation settles at the actual cost from `usage`, or is released when nothing
 * was billed. The limit itself comes from the entitlements function (PLAN §20), so it is a
 * parameter here, never a constant.
 *
 * `InMemoryBudgetLedger` is the reference implementation and the test double. The engine
 * implements `BudgetLedger` on PostgreSQL inside a `TenantTx` (integration notes in
 * `docs/evidence/ws-12-ai.md`), so every engine process shares one ledger.
 */
import { randomUUID } from 'node:crypto';

/** The budget month: `YYYY-MM` in UTC. */
export function budgetPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface Reservation {
  readonly id: string;
  readonly tenantId: string;
  readonly period: string;
  readonly amountMicroUsd: number;
}

export interface ReserveRequest {
  readonly tenantId: string;
  readonly period: string;
  readonly amountMicroUsd: number;
  readonly limitMicroUsd: number;
}

export type ReserveResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | { readonly ok: false; readonly usedMicroUsd: number; readonly limitMicroUsd: number };

export interface BudgetLedger {
  /** Atomically reserves `amountMicroUsd` if spent plus reserved stays within the limit. */
  reserve(request: ReserveRequest): Promise<ReserveResult>;
  /** Replaces the reservation by the actual cost. Settling twice is a no-op. */
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
  /** Returns the reservation to the budget. A no-op once settled or released. */
  release(reservationId: string): Promise<void>;
}

function assertMicroUsd(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of micro-dollars`);
  }
}

/** Runs `fn` and reports a throw as a rejected promise, as an async ledger would. */
function settled<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

interface Totals {
  spentMicroUsd: number;
  reservedMicroUsd: number;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  readonly #totals = new Map<string, Totals>();
  readonly #reservations = new Map<
    string,
    { readonly key: string; readonly amount: number; state: 'held' | 'closed' }
  >();

  usage(tenantId: string, period: string): Readonly<Totals> {
    return {
      ...(this.#totals.get(`${tenantId}/${period}`) ?? { spentMicroUsd: 0, reservedMicroUsd: 0 }),
    };
  }

  reserve(request: ReserveRequest): Promise<ReserveResult> {
    return settled(() => this.#reserve(request));
  }

  settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    return settled(() => {
      assertMicroUsd('actualMicroUsd', actualMicroUsd);
      this.#close(reservationId, actualMicroUsd);
    });
  }

  release(reservationId: string): Promise<void> {
    return settled(() => {
      this.#close(reservationId, 0);
    });
  }

  #reserve(request: ReserveRequest): ReserveResult {
    assertMicroUsd('amountMicroUsd', request.amountMicroUsd);
    assertMicroUsd('limitMicroUsd', request.limitMicroUsd);
    const key = `${request.tenantId}/${request.period}`;
    const totals = this.#totals.get(key) ?? { spentMicroUsd: 0, reservedMicroUsd: 0 };
    const used = totals.spentMicroUsd + totals.reservedMicroUsd;
    if (used + request.amountMicroUsd > request.limitMicroUsd || request.limitMicroUsd === 0) {
      return { ok: false, usedMicroUsd: used, limitMicroUsd: request.limitMicroUsd };
    }
    totals.reservedMicroUsd += request.amountMicroUsd;
    this.#totals.set(key, totals);
    const id = randomUUID();
    this.#reservations.set(id, { key, amount: request.amountMicroUsd, state: 'held' });
    return {
      ok: true,
      reservation: {
        id,
        tenantId: request.tenantId,
        period: request.period,
        amountMicroUsd: request.amountMicroUsd,
      },
    };
  }

  #close(reservationId: string, spent: number): void {
    const r = this.#reservations.get(reservationId);
    if (r === undefined) {
      throw new Error('unknown reservation');
    }
    if (r.state === 'closed') {
      return;
    }
    r.state = 'closed';
    const totals = this.#totals.get(r.key) ?? { spentMicroUsd: 0, reservedMicroUsd: 0 };
    totals.reservedMicroUsd -= r.amount;
    totals.spentMicroUsd += spent;
    this.#totals.set(r.key, totals);
  }
}
