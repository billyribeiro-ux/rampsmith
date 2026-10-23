import { describe, expect, it } from 'vitest';
import { effectiveBudgetMicroUsd, monthlyWindow } from '../../src/ai/allowance.ts';
import { characterLimit } from '../../src/jobs/alt-text.ts';

const at = (iso: string): Date => new Date(iso);
const window = (anchor: string, now: string): [string, string] => {
  const w = monthlyWindow(at(anchor), at(now));
  return [w.start.toISOString(), w.end.toISOString()];
};

// The vectors of `billing::usage` (crates/billing/src/usage.rs): the engine and the api must
// agree on every window, or the engine would count a different month than the one the api shows.
describe('monthlyWindow, the twin of billing::usage::monthly_window', () => {
  it('starts on the anchor day and time', () => {
    expect(window('2026-01-15T10:30:00Z', '2026-03-20T08:00:00Z')).toEqual([
      '2026-03-15T10:30:00.000Z',
      '2026-04-15T10:30:00.000Z',
    ]);
    expect(window('2026-01-15T10:30:00Z', '2026-03-15T10:29:59Z')).toEqual([
      '2026-02-15T10:30:00.000Z',
      '2026-03-15T10:30:00.000Z',
    ]);
    expect(window('2026-01-15T10:30:00Z', '2026-03-15T10:30:00Z')[0]).toBe(
      '2026-03-15T10:30:00.000Z',
    );
  });

  it('clamps the 31st to shorter months and comes back', () => {
    const anchor = '2026-01-31T10:00:00Z';
    expect(window(anchor, '2026-02-15T00:00:00Z')).toEqual([
      '2026-01-31T10:00:00.000Z',
      '2026-02-28T10:00:00.000Z',
    ]);
    expect(window(anchor, '2026-02-28T10:00:00Z')).toEqual([
      '2026-02-28T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
    ]);
    expect(window(anchor, '2026-04-30T12:00:00Z')).toEqual([
      '2026-04-30T10:00:00.000Z',
      '2026-05-31T10:00:00.000Z',
    ]);
  });

  it('knows leap years', () => {
    expect(window('2028-01-31T00:00:00Z', '2028-02-29T12:00:00Z')).toEqual([
      '2028-02-29T00:00:00.000Z',
      '2028-03-31T00:00:00.000Z',
    ]);
    expect(window('2028-02-29T00:00:00Z', '2029-02-28T12:00:00Z')).toEqual([
      '2029-02-28T00:00:00.000Z',
      '2029-03-29T00:00:00.000Z',
    ]);
    expect(window('2028-02-29T00:00:00Z', '2029-02-27T23:59:00Z')).toEqual([
      '2029-01-29T00:00:00.000Z',
      '2029-02-28T00:00:00.000Z',
    ]);
    expect(window('2100-01-31T00:00:00Z', '2100-02-10T00:00:00Z')[1]).toBe(
      '2100-02-28T00:00:00.000Z',
    );
  });

  it('uses calendar months without an anchor', () => {
    const w = monthlyWindow(null, at('2026-10-22T19:00:00Z'));
    expect([w.start.toISOString(), w.end.toISOString()]).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
  });
});

describe('the budget the engine spends from (audit M2)', () => {
  it('is the merchant setting, never above the plan ceiling, and the ceiling by default', () => {
    expect(effectiveBudgetMicroUsd(undefined, 500_000)).toBe(500_000);
    expect(effectiveBudgetMicroUsd(100_000, 500_000)).toBe(100_000);
    expect(effectiveBudgetMicroUsd(99_000_000, 500_000)).toBe(500_000);
    expect(effectiveBudgetMicroUsd(0, 500_000)).toBe(0);
  });

  it('ignores an alt-text length outside 40 to 300', () => {
    expect(characterLimit({ alt_text_max_characters: 80 })).toBe(80);
    expect(characterLimit({ alt_text_max_characters: 40 })).toBe(40);
    expect(characterLimit({ alt_text_max_characters: 300 })).toBe(300);
    for (const bad of [0, 39, 301, 1e9, 99.5, -1, '80', null]) {
      expect(characterLimit({ alt_text_max_characters: bad }), String(bad)).toBeUndefined();
    }
    expect(characterLimit(null)).toBeUndefined();
    expect(characterLimit({})).toBeUndefined();
  });
});
