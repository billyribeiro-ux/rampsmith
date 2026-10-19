// Compares a page's golden occurrences with axe-core's result nodes (corpus/CONTRACT.md,
// "Checks"). Elements are identified by their index in document order (`querySelectorAll('*')`),
// so a golden selector and an axe target that name the same element compare equal however each
// is written.
import type { Impact, Outcome } from '../golden.ts';

/** One axe-core result node: the rule, violation or incomplete, and the element's index. */
export interface AxeNode {
  readonly rule: string;
  readonly outcome: Outcome;
  readonly impact: Impact | null;
  readonly index: number;
  readonly target: string;
  /** Data axe-core's checks reported for the node, by check id (`color-contrast`, `target-size`). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** A golden occurrence with its selector resolved on the rendered page. */
export interface ResolvedOccurrence {
  readonly finding: string;
  readonly rule: string;
  readonly outcome: Outcome;
  readonly impact: Impact;
  readonly selector: string;
  readonly indices: readonly number[];
  readonly expectedCount: number;
}

export interface PageComparison {
  readonly missing: readonly {
    readonly finding: string;
    readonly rule: string;
    readonly outcome: Outcome;
    readonly selector: string;
    readonly index: number;
  }[];
  readonly unexpected: readonly {
    readonly rule: string;
    readonly outcome: Outcome;
    readonly index: number;
    readonly target: string;
  }[];
  readonly countMismatch: readonly {
    readonly finding: string;
    readonly selector: string;
    readonly expected: number;
    readonly actual: number;
  }[];
  readonly impactMismatch: readonly {
    readonly finding: string;
    readonly rule: string;
    readonly index: number;
    readonly expected: Impact;
    readonly actual: Impact | null;
  }[];
  /** One element claimed for one rule and outcome by more than one finding. */
  readonly duplicate: readonly {
    readonly rule: string;
    readonly outcome: Outcome;
    readonly index: number;
    readonly findings: readonly string[];
  }[];
}

const key = (rule: string, outcome: Outcome, index: number): string =>
  `${rule}\u0000${outcome}\u0000${String(index)}`;

/**
 * The page passes when the comparison is empty: every element a golden selector matches is a
 * result node of that rule and outcome with the golden impact, every selector matches the
 * golden count, and no result node is left unexplained.
 */
export function comparePage(
  occurrences: readonly ResolvedOccurrence[],
  nodes: readonly AxeNode[],
): PageComparison {
  const byKey = new Map(nodes.map((n) => [key(n.rule, n.outcome, n.index), n]));
  const covered = new Set<string>();
  const claims = new Map<
    string,
    { rule: string; outcome: Outcome; index: number; findings: string[] }
  >();
  const missing: PageComparison['missing'][number][] = [];
  const countMismatch: PageComparison['countMismatch'][number][] = [];
  const impactMismatch: PageComparison['impactMismatch'][number][] = [];
  for (const o of occurrences) {
    if (o.indices.length !== o.expectedCount) {
      countMismatch.push({
        finding: o.finding,
        selector: o.selector,
        expected: o.expectedCount,
        actual: o.indices.length,
      });
    }
    for (const index of o.indices) {
      const k = key(o.rule, o.outcome, index);
      covered.add(k);
      const claim = claims.get(k) ?? { rule: o.rule, outcome: o.outcome, index, findings: [] };
      if (!claim.findings.includes(o.finding)) claim.findings.push(o.finding);
      claims.set(k, claim);
      const hit = byKey.get(k);
      if (hit === undefined) {
        missing.push({
          finding: o.finding,
          rule: o.rule,
          outcome: o.outcome,
          selector: o.selector,
          index,
        });
      } else if (hit.impact !== o.impact) {
        impactMismatch.push({
          finding: o.finding,
          rule: o.rule,
          index,
          expected: o.impact,
          actual: hit.impact,
        });
      }
    }
  }
  const unexpected = nodes
    .filter((n) => !covered.has(key(n.rule, n.outcome, n.index)))
    .map((n) => ({ rule: n.rule, outcome: n.outcome, index: n.index, target: n.target }));
  const duplicate = [...claims.values()].filter((c) => c.findings.length > 1);
  return { missing, unexpected, countMismatch, impactMismatch, duplicate };
}

/** Result nodes per `<ruleId>:<outcome>`, the shape `PageScan.counts` takes (metrics.ts). */
export function summarizeCounts(nodes: readonly AxeNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    const k = `${n.rule}:${n.outcome}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
