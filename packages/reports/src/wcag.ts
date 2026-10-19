// The WCAG 2.2 success criteria at Level A and AA, the standard every Rampsmith report names
// (PLAN §1, §11). Numbers and levels are from the W3C Recommendation of 12 December 2024
// (https://www.w3.org/TR/WCAG22/), read on 18 October 2026; 4.1.1 Parsing is obsolete and
// removed there, so it is not listed. Each criterion's short name lives in the message
// catalog (`wcag_<number>`) so a translation can use the W3C's authorized wording (ADR-221).

export type WcagLevel = 'A' | 'AA';

export interface SuccessCriterion {
  /** The criterion number, such as `1.4.10`, exactly as stored in `findings.criteria`. */
  readonly id: string;
  readonly level: WcagLevel;
}

const A = 'A';
const AA = 'AA';

export const WCAG22_AA: readonly SuccessCriterion[] = (
  [
    ['1.1.1', A],
    ['1.2.1', A],
    ['1.2.2', A],
    ['1.2.3', A],
    ['1.2.4', AA],
    ['1.2.5', AA],
    ['1.3.1', A],
    ['1.3.2', A],
    ['1.3.3', A],
    ['1.3.4', AA],
    ['1.3.5', AA],
    ['1.4.1', A],
    ['1.4.2', A],
    ['1.4.3', AA],
    ['1.4.4', AA],
    ['1.4.5', AA],
    ['1.4.10', AA],
    ['1.4.11', AA],
    ['1.4.12', AA],
    ['1.4.13', AA],
    ['2.1.1', A],
    ['2.1.2', A],
    ['2.1.4', A],
    ['2.2.1', A],
    ['2.2.2', A],
    ['2.3.1', A],
    ['2.4.1', A],
    ['2.4.2', A],
    ['2.4.3', A],
    ['2.4.4', A],
    ['2.4.5', AA],
    ['2.4.6', AA],
    ['2.4.7', AA],
    ['2.4.11', AA],
    ['2.5.1', A],
    ['2.5.2', A],
    ['2.5.3', A],
    ['2.5.4', A],
    ['2.5.7', AA],
    ['2.5.8', AA],
    ['3.1.1', A],
    ['3.1.2', AA],
    ['3.2.1', A],
    ['3.2.2', A],
    ['3.2.3', AA],
    ['3.2.4', AA],
    ['3.2.6', A],
    ['3.3.1', A],
    ['3.3.2', A],
    ['3.3.3', AA],
    ['3.3.4', AA],
    ['3.3.7', A],
    ['3.3.8', AA],
    ['4.1.2', A],
    ['4.1.3', AA],
  ] as const
).map(([id, level]) => ({ id, level }));

const IDS = new Set(WCAG22_AA.map((c) => c.id));

/** Whether `id` names a WCAG 2.2 Level A or AA success criterion. */
export function isWcag22AaCriterion(id: string): boolean {
  return IDS.has(id);
}

/** Orders criterion numbers numerically, part by part: 1.4.3 before 1.4.10. */
export function compareCriteria(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The message key of a criterion's short name. */
export function criterionNameKey(id: string): `wcag_${string}` {
  return `wcag_${id.replaceAll('.', '_')}`;
}
