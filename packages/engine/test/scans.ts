/** Builders for `PageScan` values in tests. */
import type { Occurrence, PageScan, StateScan } from '../src/scan-page.ts';

export function stateScan(
  state: StateScan['state'],
  violations: Occurrence[] = [],
  extra: Partial<StateScan> = {},
): StateScan {
  return {
    state,
    result: 'opened',
    reason: undefined,
    violations,
    incomplete: [],
    bestPractice: [],
    rulesRun: ['image-alt'],
    checksRun: 10,
    checksPassed: 10 - violations.length,
    durationMs: 100,
    ...extra,
  };
}

/** A page checked in its default state only. */
export function pageScan(
  url: string,
  violations: Occurrence[],
  finalUrl: string = url,
  extra: Partial<PageScan> = {},
): PageScan {
  return {
    url,
    finalUrl,
    status: 200,
    blocked: undefined,
    states: [stateScan('default', violations)],
    crops: {},
    durationMs: 1234.5,
    ...extra,
  };
}
