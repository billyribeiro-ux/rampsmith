// The runner's JSON report (corpus/CONTRACT.md, "The integrated runner"; ADR-247): the two R2
// gates, the numbers per category, every finding's mapping and fix, the regressions, and the
// diffs the engine produced. Pure: it reads a finished run.
import type { Category } from '../golden.ts';
import type { CorpusReport, FixRecord, MappingRecord, PageScan } from '../contract/metrics.ts';
import type { CorpusRun, FindingResult, RunOptions } from './run.ts';

/** Mapping and fixing numbers for the findings of one category (or all of them). */
export interface CategoryRow {
  readonly category: Category | 'all';
  readonly findings: number;
  /** Findings that need mapping (the rendered ones), and how many mapped correctly at 0.9+. */
  readonly needMapping: number;
  readonly mappedCorrectly: number;
  readonly mappingAccuracy: number | null;
  /** Targeted findings (PLAN §5), and how many the engine fixed. */
  readonly targeted: number;
  readonly fixed: number;
  readonly fixRate: number | null;
}

export interface JsonReport {
  readonly generatedBy: 'packages/corpus-tools runner (ADR-247)';
  readonly options: { readonly spans: 'mapper' | 'golden'; readonly withoutRecipes: string[] };
  readonly passed: boolean;
  readonly gates: CorpusReport['gates'];
  readonly mapping: CorpusReport['mapping'];
  readonly fixes: CorpusReport['fixes'];
  readonly regressions: CorpusReport['regressions'];
  readonly newThemeCheckOffenses: Readonly<Record<string, readonly string[]>>;
  /** Where a patched page does not keep part of the page before (ADR-247, point 3). */
  readonly domViolations: readonly string[];
  /** Elements added by the patches, per theme and page. */
  readonly addedElements: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly categories: readonly CategoryRow[];
  readonly themes: readonly {
    readonly theme: string;
    readonly findings: number;
    readonly mappingCorrect: number;
    readonly targeted: number;
    readonly fixed: number;
    readonly patchedFiles: readonly string[];
  }[];
  readonly findings: readonly FindingResult[];
  readonly problems: readonly string[];
  /** One unified diff per patched file, by theme. */
  readonly diffs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function row(category: Category | 'all', findings: readonly FindingResult[]): CategoryRow {
  const needMapping = findings.filter((f) => f.mapping.verdict !== 'not-needed');
  const mappedCorrectly = needMapping.filter((f) => f.mapping.verdict === 'correct').length;
  const targeted = findings.filter((f) => f.targeted);
  const fixed = targeted.filter((f) => f.fix.verdict === 'fixed').length;
  return {
    category,
    findings: findings.length,
    needMapping: needMapping.length,
    mappedCorrectly,
    mappingAccuracy: ratio(mappedCorrectly, needMapping.length),
    targeted: targeted.length,
    fixed,
    fixRate: ratio(fixed, targeted.length),
  };
}

/** Per-category numbers over the findings of the failing themes, then the total. */
export function categoryRows(findings: readonly FindingResult[]): CategoryRow[] {
  const categories = [...new Set(findings.map((f) => f.category))].sort();
  return [
    ...categories.map((c) =>
      row(
        c,
        findings.filter((f) => f.category === c),
      ),
    ),
    row('all', findings),
  ];
}

/** The report as plain JSON-serialisable data. */
export function jsonReport(run: CorpusRun, options: RunOptions = {}): JsonReport {
  const { mapping, fixes, regressions, gates, passed } = run.report;
  return {
    generatedBy: 'packages/corpus-tools runner (ADR-247)',
    options: {
      spans: options.spans ?? 'mapper',
      withoutRecipes: [...(options.withoutRecipes ?? [])],
    },
    passed,
    gates,
    mapping,
    fixes,
    regressions,
    newThemeCheckOffenses: Object.fromEntries(
      run.themes.map((t) => [t.theme, t.newThemeCheckOffenses]),
    ),
    domViolations: run.domViolations,
    addedElements: Object.fromEntries(run.themes.map((t) => [t.theme, t.addedElements])),
    categories: categoryRows(run.findings),
    themes: run.themes.map((t) => {
      const own = run.findings.filter((f) => f.theme === t.theme);
      const targeted = own.filter((f) => f.targeted);
      return {
        theme: t.theme,
        findings: own.length,
        mappingCorrect: own.filter((f) => f.mapping.verdict === 'correct').length,
        targeted: targeted.length,
        fixed: targeted.filter((f) => f.fix.verdict === 'fixed').length,
        patchedFiles: Object.keys(t.diffs).sort(),
      };
    }),
    findings: run.findings,
    problems: run.problems,
    diffs: Object.fromEntries(run.themes.map((t) => [t.theme, t.diffs])),
  };
}

/** The records of `corpus/schema/runner-records.schema.json`, as the runner measured them. */
export interface RunnerRecords {
  readonly corpus: string;
  readonly mapping: readonly MappingRecord[];
  readonly fixes: readonly FixRecord[];
  readonly scans: { readonly before: readonly PageScan[]; readonly after: readonly PageScan[] };
  readonly themeCheck: readonly { readonly theme: string; readonly count: number }[];
}

/** What the runner recorded, in the shape the contract's schema defines. */
export function runnerRecords(run: CorpusRun, corpusCommit: string): RunnerRecords {
  return {
    corpus: corpusCommit,
    mapping: run.mapping,
    fixes: run.fixes,
    scans: {
      before: run.themes.flatMap((t) => t.before),
      after: run.themes.flatMap((t) => t.after),
    },
    themeCheck: run.themes.map((t) => ({ theme: t.theme, count: t.newThemeCheckOffenses.length })),
  };
}
