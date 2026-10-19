import { describe, expect, it } from 'vitest';
import { InMemoryBudgetLedger, budgetPeriod } from '../src/budget.ts';

const T = '0190e8d2-0000-7000-8000-000000000001';
const U = '0190e8d2-0000-7000-8000-000000000002';

describe('budgetPeriod', () => {
  it('is the UTC calendar month', () => {
    expect(budgetPeriod(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe('2026-10');
    expect(budgetPeriod(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe('2026-11');
  });
});

describe('InMemoryBudgetLedger (the per-store monthly budget guard, PLAN §13)', () => {
  it('reserves the worst case before the call and settles the actual cost after', async () => {
    const ledger = new InMemoryBudgetLedger();
    const r = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 400,
      limitMicroUsd: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ledger.usage(T, '2026-10')).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 400 });
    await ledger.settle(r.reservation.id, 120);
    expect(ledger.usage(T, '2026-10')).toEqual({ spentMicroUsd: 120, reservedMicroUsd: 0 });
  });

  it('refuses a call whose worst case would cross the limit', async () => {
    const ledger = new InMemoryBudgetLedger();
    const a = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 700,
      limitMicroUsd: 1000,
    });
    expect(a.ok).toBe(true);
    const b = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 301,
      limitMicroUsd: 1000,
    });
    expect(b).toEqual({ ok: false, usedMicroUsd: 700, limitMicroUsd: 1000 });
    const c = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 300,
      limitMicroUsd: 1000,
    });
    expect(c.ok).toBe(true);
  });

  it('keeps tenants and months apart', async () => {
    const ledger = new InMemoryBudgetLedger();
    await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 1000,
      limitMicroUsd: 1000,
    });
    expect(
      (
        await ledger.reserve({
          tenantId: U,
          period: '2026-10',
          amountMicroUsd: 1000,
          limitMicroUsd: 1000,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await ledger.reserve({
          tenantId: T,
          period: '2026-11',
          amountMicroUsd: 1000,
          limitMicroUsd: 1000,
        })
      ).ok,
    ).toBe(true);
  });

  it('returns a released reservation to the budget', async () => {
    const ledger = new InMemoryBudgetLedger();
    const r = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 1000,
      limitMicroUsd: 1000,
    });
    if (!r.ok) throw new Error('reserve failed');
    await ledger.release(r.reservation.id);
    expect(ledger.usage(T, '2026-10')).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0 });
  });

  it('is idempotent, because jobs run at least once', async () => {
    const ledger = new InMemoryBudgetLedger();
    const r = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 500,
      limitMicroUsd: 1000,
    });
    if (!r.ok) throw new Error('reserve failed');
    await ledger.settle(r.reservation.id, 200);
    await ledger.settle(r.reservation.id, 200);
    await ledger.release(r.reservation.id);
    expect(ledger.usage(T, '2026-10')).toEqual({ spentMicroUsd: 200, reservedMicroUsd: 0 });
  });

  it('rejects nonsense amounts and unknown reservations', async () => {
    const ledger = new InMemoryBudgetLedger();
    await expect(
      ledger.reserve({ tenantId: T, period: '2026-10', amountMicroUsd: -1, limitMicroUsd: 10 }),
    ).rejects.toThrow(RangeError);
    await expect(ledger.settle('nope', 1)).rejects.toThrow(/unknown reservation/u);
  });

  it('allows nothing when the limit is zero', async () => {
    const ledger = new InMemoryBudgetLedger();
    const r = await ledger.reserve({
      tenantId: T,
      period: '2026-10',
      amountMicroUsd: 1,
      limitMicroUsd: 0,
    });
    expect(r.ok).toBe(false);
  });
});
