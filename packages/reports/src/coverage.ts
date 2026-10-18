// The coverage disclosure every report carries (PLAN §11): which WCAG 2.2 A and AA criteria
// the automated checks test, which they test only in part, and which need a person (ADR-225).
import { ReportInputError, requireCount, requireLine } from './validate.ts';
import { WCAG22_AA, compareCriteria, isWcag22AaCriterion, type SuccessCriterion } from './wcag.ts';

/**
 * How a scan's ruleset covers the criteria. Every A and AA criterion not named in
 * `automated` or `partial` needs a person.
 */
export interface CoverageInput {
  /** Criteria whose testable conditions the automated checks decide entirely. */
  readonly automated: readonly string[];
  /** Criteria the automated checks test only in part. */
  readonly partial: readonly string[];
  /** The scan's `ruleset_version`: the axe-core version and the custom rules' hash. */
  readonly rulesetVersion: string;
  /** Results the checks could not decide (axe-core "incomplete"), waiting for a person. */
  readonly reviewQueue?: number;
}

export interface Coverage {
  readonly automated: readonly SuccessCriterion[];
  readonly partial: readonly SuccessCriterion[];
  readonly manual: readonly SuccessCriterion[];
  readonly rulesetVersion: string;
  readonly reviewQueue: number | undefined;
}

/** Validates a disclosure and sorts every A and AA criterion into exactly one group. */
export function classifyCoverage(input: CoverageInput, field = 'coverage'): Coverage {
  const automated = new Set(input.automated);
  const partial = new Set(input.partial);
  for (const [name, ids] of [
    ['automated', automated],
    ['partial', partial],
  ] as const) {
    for (const id of ids) {
      if (!isWcag22AaCriterion(id)) {
        throw new ReportInputError(
          `${field}.${name}`,
          `${JSON.stringify(id)} is not a WCAG 2.2 Level A or AA success criterion`,
        );
      }
      if (name === 'partial' && automated.has(id)) {
        throw new ReportInputError(
          `${field}.partial`,
          `${id} is listed both as automated and partial`,
        );
      }
    }
  }
  const rulesetVersion = requireLine(`${field}.rulesetVersion`, input.rulesetVersion);
  if (input.reviewQueue !== undefined) {
    try {
      requireCount(`${field}.reviewQueue`, input.reviewQueue);
    } catch {
      throw new ReportInputError(
        `${field}.reviewQueue`,
        'review count must be a whole number of zero or more',
      );
    }
  }
  return {
    automated: WCAG22_AA.filter((c) => automated.has(c.id)),
    partial: WCAG22_AA.filter((c) => partial.has(c.id)),
    manual: WCAG22_AA.filter((c) => !automated.has(c.id) && !partial.has(c.id)),
    rulesetVersion,
    reviewQueue: input.reviewQueue,
  };
}

/**
 * axe-core tags name success criteria as `wcag` plus the digits of the number: `wcag111`
 * is 1.1.1 and `wcag1410` is 1.4.10. Principle and guideline are single digits in WCAG 2.2,
 * so the rest is the criterion. Level tags (`wcag2aa`, `wcag21a`) and AAA criteria are
 * dropped, and so is 4.1.1, which WCAG 2.2 removed.
 */
export function criteriaFromAxeTags(tags: readonly string[]): string[] {
  const found = new Set<string>();
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/u.exec(tag);
    if (m !== null) {
      const id = `${m[1] ?? ''}.${m[2] ?? ''}.${m[3] ?? ''}`;
      if (isWcag22AaCriterion(id)) found.add(id);
    }
  }
  return [...found].sort(compareCriteria);
}

/**
 * A disclosure from the rules a scan ran. Any criterion a rule tests counts as tested in
 * part: an automated rule can show that something fails, rarely that a criterion is met.
 * A criterion moves to `automated` only when the caller names it and a rule covers it.
 */
export function coverageFromRules(options: {
  readonly rules: readonly { readonly criteria: readonly string[] }[];
  readonly automated?: readonly string[];
  readonly rulesetVersion: string;
  readonly reviewQueue?: number;
}): CoverageInput {
  const tested = new Set(
    options.rules.flatMap((r) => r.criteria).filter((id) => isWcag22AaCriterion(id)),
  );
  const automated = [...new Set(options.automated ?? [])].sort(compareCriteria);
  for (const id of automated) {
    if (!tested.has(id)) {
      throw new ReportInputError(
        'automated',
        `${id} has no rule in this ruleset, so it cannot be automated`,
      );
    }
  }
  const partial = [...tested].filter((id) => !automated.includes(id)).sort(compareCriteria);
  return {
    automated,
    partial,
    rulesetVersion: options.rulesetVersion,
    ...(options.reviewQueue === undefined ? {} : { reviewQueue: options.reviewQueue }),
  };
}
