import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURES, PLANS, includes, unlockedBy, usd } from './plans.ts';

/** The rows of PLAN §20's plan table: name, monthly, yearly, scans, fix channels, alt text. */
function planTable(): string[][] {
  const plan = readFileSync(new URL('../../../../../docs/PLAN.md', import.meta.url), 'utf8');
  const section = plan.slice(plan.indexOf('### Plans (USD, billed through Shopify App Pricing)'));
  return section
    .split('\n')
    .slice(0, 12)
    .filter((line) => /^\| (Free|Starter|Growth|Pro) \|/u.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

const dollars = (cell: string | undefined): number => Number((cell ?? '').replace(/[$,]/gu, ''));

describe('the plans match PLAN §20', () => {
  const rows = planTable();

  it('reads four plans from the plan document', () => {
    expect(rows.map((r) => r[0])).toEqual(['Free', 'Starter', 'Growth', 'Pro']);
  });

  it.each(PLANS.map((p, i) => [p.id, p, i] as const))('%s prices and allowance', (_id, plan, i) => {
    const row = rows[i];
    expect(dollars(row?.[1])).toBe(plan.monthly);
    expect(dollars(row?.[2])).toBe(plan.yearly);
    const drafts = Number((/[\d,]+/u.exec(row?.[5] ?? '')?.[0] ?? '').replace(/,/gu, ''));
    expect(drafts).toBe(plan.altTextDrafts);
  });

  it('gives two months free on the yearly price', () => {
    for (const plan of PLANS) expect(plan.yearly).toBe(plan.monthly * 10);
  });

  it('keeps the Starter fix channel from ADR-141', () => {
    expect(rows[1]?.[4]).toBe('Data fixes; the 6 core recipes as GitHub pull requests (ADR-141)');
  });
});

describe('plan gating', () => {
  it('only ever adds features as the plan rises', () => {
    const ids = PLANS.map((p) => p.id);
    for (const feature of FEATURES) {
      const flags = ids.map((id) => includes(id, feature));
      expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
    }
  });

  it('matches the plan table’s "Adds" columns', () => {
    expect(unlockedBy('core_prs')).toBe('starter');
    expect(unlockedBy('all_recipes')).toBe('growth');
    expect(unlockedBy('rewrites')).toBe('growth');
    expect(unlockedBy('alerts')).toBe('growth');
    expect(unlockedBy('custom_widgets')).toBe('pro');
    expect(unlockedBy('languages')).toBe('pro');
    expect(unlockedBy('priority')).toBe('pro');
    expect(includes('free', 'data_fixes')).toBe(true);
    expect(includes('free', 'core_prs')).toBe(false);
  });
});

describe('usd', () => {
  it('writes whole dollars with a thousands separator', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(4990)).toBe('$4,990');
  });
});
