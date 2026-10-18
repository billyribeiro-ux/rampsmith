// Scoring of the corpus runner contract (corpus/CONTRACT.md, ADR-203). Pure functions: the
// runner gathers mapping and fix records, then these decide the two R2 gates (PLAN §5, §23):
// - mapping: at least 95% of findings that need mapping are mapped to the golden span at
//   confidence 0.9 or above, and no finding is mapped to another span at 0.9 or above;
// - fixes: the patch engine fixes at least 90% of targeted findings, with zero regressions.
import type { ExpectedFix, GoldenFinding, MappingExpectation, Span } from '../golden.ts';

export const MAPPING_THRESHOLD = 0.9;
export const MAPPING_ACCURACY_GATE = 0.95;
export const FIX_RATE_GATE = 0.9;

/** The fields of a golden finding the scores read, with the corpus-wide id `<theme>/<id>`. */
export interface ScoredFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly mapping: MappingExpectation;
  readonly span: Span;
  readonly expectedFix: ExpectedFix;
}

/** Corpus-wide view of a theme's golden findings. */
export function scored(theme: string, findings: readonly GoldenFinding[]): ScoredFinding[] {
  return findings.map((f) => ({
    id: `${theme}/${f.id}`,
    ruleId: f.ruleId,
    mapping: f.mapping,
    span: f.span,
    expectedFix: f.expectedFix,
  }));
}

/** True when the mapper's span is the golden span (CONTRACT.md, "Span equality"). */
export function spansEqual(golden: Span, actual: Span): boolean {
  switch (golden.kind) {
    case 'element':
      return (
        actual.kind === 'element' &&
        actual.file === golden.file &&
        actual.start === golden.start &&
        actual.tag === golden.tag
      );
    case 'json-value':
      return (
        actual.kind === 'json-value' &&
        actual.file === golden.file &&
        actual.pointer === golden.pointer &&
        actual.start === golden.start &&
        actual.end === golden.end
      );
    case 'css-declaration':
      return (
        actual.kind === 'css-declaration' &&
        actual.file === golden.file &&
        actual.start === golden.start &&
        actual.end === golden.end &&
        actual.property === golden.property
      );
    case 'data':
      return (
        actual.kind === 'data' &&
        actual.resource === golden.resource &&
        actual.field === golden.field &&
        actual.start === golden.start &&
        actual.end === golden.end
      );
  }
}

/** What the mapper returned for one golden finding, as recorded by the runner. */
export interface MappingRecord {
  readonly finding: string;
  readonly status: 'mapped' | 'needs_review' | 'unmapped';
  readonly span?: Span;
  readonly confidence?: number;
}

export type MappingVerdict =
  'correct' | 'wrong-above-threshold' | 'below-threshold' | 'needs-review' | 'unmapped' | 'missing';

export interface MappingScore {
  readonly threshold: number;
  readonly denominator: number;
  readonly correct: number;
  readonly wrongAboveThreshold: number;
  readonly belowThreshold: number;
  readonly needsReview: number;
  readonly unmapped: number;
  readonly missing: number;
  readonly accuracy: number;
  readonly passed: boolean;
  readonly verdicts: readonly { readonly finding: string; readonly verdict: MappingVerdict }[];
}

function indexRecords<R extends { readonly finding: string }>(
  goldens: readonly ScoredFinding[],
  records: readonly R[],
): Map<string, R> {
  const known = new Set(goldens.map((g) => g.id));
  const byFinding = new Map<string, R>();
  for (const record of records) {
    if (!known.has(record.finding))
      throw new Error(`a record names unknown finding ${record.finding}`);
    if (byFinding.has(record.finding))
      throw new Error(`finding ${record.finding} is recorded twice`);
    byFinding.set(record.finding, record);
  }
  return byFinding;
}

function mappingVerdict(
  golden: ScoredFinding,
  record: MappingRecord | undefined,
  threshold: number,
): MappingVerdict {
  if (record === undefined) return 'missing';
  if (record.status === 'needs_review') return 'needs-review';
  if (record.status === 'unmapped') return 'unmapped';
  const { span, confidence } = record;
  if (span === undefined || confidence === undefined) {
    throw new Error(`mapped finding ${record.finding} needs a span and a confidence`);
  }
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new Error(
      `finding ${record.finding} has confidence ${String(confidence)} outside [0, 1]`,
    );
  }
  if (confidence < threshold) return 'below-threshold';
  return spansEqual(golden.span, span) ? 'correct' : 'wrong-above-threshold';
}

/**
 * Mapping accuracy over the findings that need mapping (`mapping` is not `none`). A finding
 * mapped to the wrong span below the threshold counts as not mapped; at or above it, it fails
 * the gate on its own.
 */
export function scoreMapping(
  goldens: readonly ScoredFinding[],
  records: readonly MappingRecord[],
  threshold = MAPPING_THRESHOLD,
): MappingScore {
  const byFinding = indexRecords(goldens, records);
  const counted = goldens.filter((g) => g.mapping !== 'none');
  const verdicts = counted.map((g) => ({
    finding: g.id,
    verdict: mappingVerdict(g, byFinding.get(g.id), threshold),
  }));
  const count = (v: MappingVerdict): number => verdicts.filter((x) => x.verdict === v).length;
  const denominator = counted.length;
  const correct = count('correct');
  const wrongAboveThreshold = count('wrong-above-threshold');
  const accuracy = denominator === 0 ? 0 : correct / denominator;
  return {
    threshold,
    denominator,
    correct,
    wrongAboveThreshold,
    belowThreshold: count('below-threshold'),
    needsReview: count('needs-review'),
    unmapped: count('unmapped'),
    missing: count('missing'),
    accuracy,
    passed: denominator > 0 && accuracy >= MAPPING_ACCURACY_GATE && wrongAboveThreshold === 0,
    verdicts,
  };
}

/** What the patch engine did for one golden finding, and whether the rescan still fires it. */
export interface FixRecord {
  readonly finding: string;
  readonly engine: 'edits' | 'already-fixed' | 'refusal';
  readonly refusal?: string;
  /** After every patch for the theme is applied: does any occurrence still fire the rule? */
  readonly stillFiring: boolean;
}

export type FixVerdict =
  | 'fixed'
  | 'still-firing'
  | 'not-patched'
  | 'refused-as-expected'
  | 'review'
  | 'missing'
  | 'unexpected';

export interface FixScore {
  readonly targeted: number;
  readonly fixed: number;
  readonly fixRate: number;
  readonly verdicts: readonly { readonly finding: string; readonly verdict: FixVerdict }[];
  /** The engine did something other than the golden expects; reported, reviewed by a person. */
  readonly unexpected: readonly {
    readonly finding: string;
    readonly expected: string;
    readonly actual: string;
  }[];
}

function describeExpected(fix: ExpectedFix): string {
  return fix.outcome === 'refused' ? `refused:${fix.refusal ?? '?'}` : fix.outcome;
}

function describeActual(record: FixRecord): string {
  return record.engine === 'refusal' ? `refused:${record.refusal ?? '?'}` : record.engine;
}

/**
 * Fix rate over the targeted findings (`expectedFix.targeted`). A targeted finding is fixed
 * only when the engine produced edits and the rescan of the patched theme no longer fires it.
 */
export function scoreFixes(
  goldens: readonly ScoredFinding[],
  records: readonly FixRecord[],
): FixScore {
  const byFinding = indexRecords(goldens, records);
  const verdicts: { finding: string; verdict: FixVerdict }[] = [];
  const unexpected: { finding: string; expected: string; actual: string }[] = [];
  for (const golden of goldens) {
    const record = byFinding.get(golden.id);
    const expected = golden.expectedFix;
    if (record === undefined) {
      verdicts.push({ finding: golden.id, verdict: 'missing' });
      continue;
    }
    if (expected.targeted) {
      const verdict: FixVerdict =
        record.engine !== 'edits' ? 'not-patched' : record.stillFiring ? 'still-firing' : 'fixed';
      verdicts.push({ finding: golden.id, verdict });
    } else if (expected.outcome === 'refused') {
      const asExpected = record.engine === 'refusal' && record.refusal === expected.refusal;
      verdicts.push({
        finding: golden.id,
        verdict: asExpected ? 'refused-as-expected' : 'unexpected',
      });
      if (!asExpected) {
        unexpected.push({
          finding: golden.id,
          expected: describeExpected(expected),
          actual: describeActual(record),
        });
      }
    } else {
      verdicts.push({ finding: golden.id, verdict: 'review' });
    }
  }
  const targeted = goldens.filter((g) => g.expectedFix.targeted).length;
  const fixed = verdicts.filter((v) => v.verdict === 'fixed').length;
  return { targeted, fixed, fixRate: targeted === 0 ? 0 : fixed / targeted, verdicts, unexpected };
}

/** One page of one theme, scanned before or after patching. */
export interface PageScan {
  readonly theme: string;
  readonly page: string;
  readonly rendered: boolean;
  readonly error?: string;
  /** Result nodes per `<ruleId>:<outcome>`, such as `label:violation`. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface Regression {
  readonly theme: string;
  readonly page: string;
  readonly kind: 'render-failed' | 'page-missing' | 'new-result' | 'theme-check';
  readonly detail: string;
}

/**
 * Render regressions (CONTRACT.md): a page that rendered before the patch and does not after,
 * or is not scanned after; any rule and outcome whose node count rises on any page; and any new
 * Theme Check offense in the patched theme.
 */
export function findRegressions(
  before: readonly PageScan[],
  after: readonly PageScan[],
  themeCheck: readonly { readonly theme: string; readonly count: number }[] = [],
): Regression[] {
  const regressions: Regression[] = [];
  const afterByKey = new Map(after.map((p) => [`${p.theme}\u0000${p.page}`, p]));
  for (const page of before) {
    if (!page.rendered) continue;
    const next = afterByKey.get(`${page.theme}\u0000${page.page}`);
    if (next === undefined) {
      regressions.push({
        theme: page.theme,
        page: page.page,
        kind: 'page-missing',
        detail: 'the page was scanned before the patch but not after',
      });
      continue;
    }
    if (!next.rendered) {
      regressions.push({
        theme: page.theme,
        page: page.page,
        kind: 'render-failed',
        detail: next.error ?? 'the page did not render',
      });
      continue;
    }
    const keys = [...new Set([...Object.keys(page.counts), ...Object.keys(next.counts)])].sort();
    for (const key of keys) {
      const was = page.counts[key] ?? 0;
      const now = next.counts[key] ?? 0;
      if (now > was) {
        regressions.push({
          theme: page.theme,
          page: page.page,
          kind: 'new-result',
          detail: `${key} rose from ${String(was)} to ${String(now)}`,
        });
      }
    }
  }
  for (const { theme, count } of themeCheck) {
    if (count > 0) {
      regressions.push({
        theme,
        page: '*',
        kind: 'theme-check',
        detail: `${String(count)} new Theme Check offense${count === 1 ? '' : 's'}`,
      });
    }
  }
  return regressions;
}

export interface CorpusReport {
  readonly mapping: MappingScore;
  readonly fixes: FixScore;
  readonly regressions: readonly Regression[];
  readonly gates: { readonly mapping: boolean; readonly fixes: boolean };
  readonly passed: boolean;
}

/** The runner's report: both R2 gates and everything that decided them. */
export function buildReport(input: {
  readonly mapping: MappingScore;
  readonly fixes: FixScore;
  readonly regressions: readonly Regression[];
}): CorpusReport {
  const fixesPass =
    input.fixes.targeted > 0 &&
    input.fixes.fixRate >= FIX_RATE_GATE &&
    input.regressions.length === 0;
  const gates = { mapping: input.mapping.passed, fixes: fixesPass };
  return { ...input, gates, passed: gates.mapping && gates.fixes };
}
