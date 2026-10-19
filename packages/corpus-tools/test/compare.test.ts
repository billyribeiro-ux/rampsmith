// Golden occurrences against axe-core's results on one rendered page. Written before
// src/browser/compare.ts.
import { describe, expect, it } from 'vitest';
import {
  comparePage,
  summarizeCounts,
  type AxeNode,
  type ResolvedOccurrence,
} from '../src/browser/compare.ts';

const occ = (
  finding: string,
  rule: string,
  indices: number[],
  overrides: Partial<ResolvedOccurrence> = {},
): ResolvedOccurrence => ({
  finding,
  rule,
  outcome: 'violation',
  impact: 'serious',
  selector: `.${finding}`,
  indices,
  expectedCount: indices.length,
  ...overrides,
});

const node = (rule: string, index: number, overrides: Partial<AxeNode> = {}): AxeNode => ({
  rule,
  outcome: 'violation',
  impact: 'serious',
  index,
  target: `#n${String(index)}`,
  ...overrides,
});

describe('comparePage', () => {
  it('is clean when every golden node fires and nothing else does', () => {
    const result = comparePage(
      [occ('a', 'link-name', [4, 9]), occ('b', 'label', [12])],
      [node('link-name', 4), node('link-name', 9), node('label', 12)],
    );
    expect(result).toEqual({
      missing: [],
      unexpected: [],
      countMismatch: [],
      impactMismatch: [],
      duplicate: [],
    });
  });

  it('reports a golden node that axe does not flag for that rule', () => {
    const result = comparePage([occ('a', 'link-name', [4])], [node('button-name', 4)]);
    expect(result.missing).toEqual([
      { finding: 'a', rule: 'link-name', outcome: 'violation', selector: '.a', index: 4 },
    ]);
    expect(result.unexpected).toEqual([
      { rule: 'button-name', outcome: 'violation', index: 4, target: '#n4' },
    ]);
  });

  it('keeps violations and incomplete results apart', () => {
    const result = comparePage(
      [occ('c', 'color-contrast', [7], { outcome: 'incomplete' })],
      [node('color-contrast', 7)],
    );
    expect(result.missing).toHaveLength(1);
    expect(result.unexpected).toEqual([
      { rule: 'color-contrast', outcome: 'violation', index: 7, target: '#n7' },
    ]);
  });

  it('reports a selector that matches another number of elements than the golden says', () => {
    const result = comparePage(
      [
        occ('a', 'link-name', [4, 5], { expectedCount: 1 }),
        occ('z', 'label', [], { expectedCount: 1 }),
      ],
      [node('link-name', 4), node('link-name', 5)],
    );
    expect(result.countMismatch).toEqual([
      { finding: 'a', selector: '.a', expected: 1, actual: 2 },
      { finding: 'z', selector: '.z', expected: 1, actual: 0 },
    ]);
  });

  it('reports an impact that differs from the golden', () => {
    const result = comparePage(
      [occ('a', 'image-alt', [3], { impact: 'critical' })],
      [node('image-alt', 3, { impact: 'serious' })],
    );
    expect(result.impactMismatch).toEqual([
      { finding: 'a', rule: 'image-alt', index: 3, expected: 'critical', actual: 'serious' },
    ]);
  });

  it('lets two findings cover different nodes of one rule', () => {
    const result = comparePage(
      [occ('x', 'button-name', [1]), occ('y', 'button-name', [2])],
      [node('button-name', 1), node('button-name', 2)],
    );
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
});

describe('comparePage duplicates', () => {
  it('reports two findings claiming one element for one rule, which would make the join ambiguous', () => {
    const result = comparePage(
      [occ('x', 'button-name', [1]), occ('y', 'button-name', [1])],
      [node('button-name', 1)],
    );
    expect(result.duplicate).toEqual([
      { rule: 'button-name', outcome: 'violation', index: 1, findings: ['x', 'y'] },
    ]);
  });
});

describe('summarizeCounts', () => {
  it('counts result nodes per rule and outcome', () => {
    expect(
      summarizeCounts([
        node('label', 1),
        node('label', 2),
        node('color-contrast', 3, { outcome: 'incomplete' }),
      ]),
    ).toEqual({ 'color-contrast:incomplete': 1, 'label:violation': 2 });
  });
});
