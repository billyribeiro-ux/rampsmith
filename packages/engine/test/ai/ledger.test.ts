import { budgetPeriod } from '@rampsmith/ai';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBudgetLedger } from '../../src/ai/ledger.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from '../db.ts';

let db: TestDatabase;
let worker: postgres.Sql;
let a: Fixture;
let b: Fixture;
const period = budgetPeriod(Date.UTC(2026, 9, 22));

beforeAll(async () => {
  db = await freshDatabase();
  worker = db.as('rampsmith_worker');
  a = await seed(db.owner, 'https://a.myshopify.com');
  b = await seed(db.owner, 'https://b.myshopify.com');
});
afterAll(async () => {
  await db.drop();
});

async function totals(tenantId: string) {
  const [row] = await db.owner<{ spent: string; reserved: string }[]>`
    select spent_micro_usd::text as spent, reserved_micro_usd::text as reserved
      from ai_budgets where tenant_id = ${tenantId} and period = ${period}`;
  return { spent: Number(row?.spent), reserved: Number(row?.reserved) };
}

describe('PostgresBudgetLedger (PLAN §13, ADR-214)', () => {
  it('reserves, settles at the actual cost and returns the difference to the budget', async () => {
    const ledger = new PostgresBudgetLedger(worker, a.tenantId);
    const r = await ledger.reserve({
      tenantId: a.tenantId,
      period,
      amountMicroUsd: 400,
      limitMicroUsd: 1000,
    });
    if (!r.ok) throw new Error('expected a reservation');
    expect(await totals(a.tenantId)).toEqual({ spent: 0, reserved: 400 });
    await ledger.settle(r.reservation.id, 120);
    expect(await totals(a.tenantId)).toEqual({ spent: 120, reserved: 0 });
    // Settling again changes nothing.
    await ledger.settle(r.reservation.id, 999);
    await ledger.release(r.reservation.id);
    expect(await totals(a.tenantId)).toEqual({ spent: 120, reserved: 0 });
  });

  it('refuses a reservation that spent plus reserved cannot cover, and a zero limit', async () => {
    const ledger = new PostgresBudgetLedger(worker, a.tenantId);
    const over = await ledger.reserve({
      tenantId: a.tenantId,
      period,
      amountMicroUsd: 900,
      limitMicroUsd: 1000,
    });
    expect(over).toEqual({ ok: false, usedMicroUsd: 120, limitMicroUsd: 1000 });
    const zero = await ledger.reserve({
      tenantId: a.tenantId,
      period,
      amountMicroUsd: 0,
      limitMicroUsd: 0,
    });
    expect(zero.ok).toBe(false);
    expect(await totals(a.tenantId)).toEqual({ spent: 120, reserved: 0 });
  });

  it('releases a reservation without charging it', async () => {
    const ledger = new PostgresBudgetLedger(worker, a.tenantId);
    const r = await ledger.reserve({
      tenantId: a.tenantId,
      period,
      amountMicroUsd: 300,
      limitMicroUsd: 1000,
    });
    if (!r.ok) throw new Error('expected a reservation');
    await ledger.release(r.reservation.id);
    expect(await totals(a.tenantId)).toEqual({ spent: 120, reserved: 0 });
    const [row] = await db.owner<{ state: string }[]>`
      select state from ai_reservations where id = ${r.reservation.id}`;
    expect(row?.state).toBe('released');
  });

  it('lets only one of two concurrent reservations take the last of a budget', async () => {
    const ledgers = [0, 1, 2, 3, 4, 5].map(() => new PostgresBudgetLedger(worker, b.tenantId));
    const results = await Promise.all(
      ledgers.map((l) =>
        l.reserve({ tenantId: b.tenantId, period, amountMicroUsd: 400, limitMicroUsd: 1000 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await totals(b.tenantId)).toEqual({ spent: 0, reserved: 800 });
  });

  it("cannot touch another tenant's reservation or serve another tenant", async () => {
    const owner = new PostgresBudgetLedger(worker, a.tenantId);
    const r = await owner.reserve({
      tenantId: a.tenantId,
      period,
      amountMicroUsd: 10,
      limitMicroUsd: 1000,
    });
    if (!r.ok) throw new Error('expected a reservation');
    const other = new PostgresBudgetLedger(worker, b.tenantId);
    await expect(other.release(r.reservation.id)).rejects.toThrow('unknown reservation');
    await expect(
      other.reserve({ tenantId: a.tenantId, period, amountMicroUsd: 1, limitMicroUsd: 10 }),
    ).rejects.toThrow('one tenant');
    expect((await totals(a.tenantId)).reserved).toBe(10);
  });

  it('rejects amounts that are not whole non-negative micro-dollars', async () => {
    const ledger = new PostgresBudgetLedger(worker, a.tenantId);
    await expect(
      ledger.reserve({ tenantId: a.tenantId, period, amountMicroUsd: -1, limitMicroUsd: 5 }),
    ).rejects.toThrow(RangeError);
    await expect(ledger.settle('00000000-0000-0000-0000-000000000000', 1.5)).rejects.toThrow(
      RangeError,
    );
  });
});
