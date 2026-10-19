// The integrated corpus runner (corpus/CONTRACT.md, "The integrated runner"; ADR-247): for each
// failing theme it scans every page in Chromium, joins the result nodes to the golden findings,
// maps each finding to its source with packages/liquid-patch, patches the theme with the engine's
// recipes, re-renders and rescans, and records what the contract scores.
import {
  CONFIDENCE_THRESHOLD,
  Mapper,
  buildPatch,
  localeEdits,
  planFix,
  validateNoNewOffenses,
  type Edit,
  type FixParams,
  type LocaleFile,
  type LocaleText,
  type MapOutcome,
  type MappedSpan,
} from '@rampsmith/liquid-patch';
import type { Browser } from 'playwright-core';
import { checkPage, type PageResult } from '../browser/check.ts';
import { summarizeCounts } from '../browser/compare.ts';
import { additiveChanges } from '../browser/snapshot.ts';
import type { Corpus, LoadedTheme } from '../corpus.ts';
import type { Category, ExpectedFix, GoldenFinding } from '../golden.ts';
import {
  buildReport,
  findRegressions,
  scoreFixes,
  scoreMapping,
  scored,
  spansEqual,
  type CorpusReport,
  type FixRecord,
  type FixVerdict,
  type MappingRecord,
  type MappingVerdict,
  type PageScan,
  type ScoredFinding,
  type SpanLocation,
} from '../contract/metrics.ts';
import { ThemeRenderer } from '../render/renderer.ts';
import { contrastMeasure, nodesByFinding, toFinding } from './nodes.ts';

export interface MappingDetail {
  readonly status: 'mapped' | 'needs_review' | 'unmapped';
  readonly confidence?: number;
  readonly span?: SpanLocation;
  readonly why: readonly string[];
  readonly reason?: string;
  readonly rendersFrom?: SpanLocation;
  readonly verdict: MappingVerdict | 'not-needed';
}

export interface FixDetail {
  readonly engine: FixRecord['engine'] | 'none';
  readonly refusal?: string;
  readonly detail?: string;
  readonly edits: number;
  readonly stillFiring: boolean | null;
  readonly verdict: FixVerdict;
}

export interface FindingResult {
  readonly id: string;
  readonly theme: string;
  readonly ruleId: string;
  readonly category: Category;
  readonly targeted: boolean;
  readonly nodes: number;
  readonly mapping: MappingDetail;
  readonly fix: FixDetail;
}

export interface ThemeRun {
  readonly theme: string;
  readonly mapping: readonly MappingRecord[];
  readonly fixes: readonly FixRecord[];
  readonly before: readonly PageScan[];
  readonly after: readonly PageScan[];
  readonly newThemeCheckOffenses: readonly string[];
  /**
   * Where a page after patching does not keep something of the page before (an element gone, an
   * attribute rewritten, text lost). Stricter than the contract's regressions (ADR-247).
   */
  readonly domViolations: readonly string[];
  /** Elements the patch added, per page. */
  readonly addedElements: Readonly<Record<string, number>>;
  /** One unified diff per patched file. */
  readonly diffs: Readonly<Record<string, string>>;
  /** Problems that make the run unreliable: unjoined scanner findings, patch failures. */
  readonly problems: readonly string[];
  readonly details: readonly {
    readonly id: string;
    readonly nodes: number;
    readonly mapping: MappingDetail;
    readonly fix: FixDetail;
  }[];
}

export interface CorpusRun {
  readonly goldens: readonly ScoredFinding[];
  readonly mapping: readonly MappingRecord[];
  readonly fixes: readonly FixRecord[];
  readonly report: CorpusReport;
  readonly findings: readonly FindingResult[];
  readonly themes: readonly ThemeRun[];
  readonly problems: readonly string[];
  /** Every theme's `domViolations`, prefixed by theme and page. */
  readonly domViolations: readonly string[];
}

export interface RunOptions {
  /** Only these themes (by name); default, or empty: every failing theme. */
  readonly themes?: readonly string[];
  /**
   * Where fixes are applied: the mapper's span (default) or the golden span, which measures the
   * recipes without the mapper (the "before" measurement of ADR-249).
   */
  readonly spans?: 'mapper' | 'golden';
  /** Rules treated as having no recipe, to measure the engine without a recipe it lacked. */
  readonly withoutRecipes?: readonly string[];
}

function spanKey(span: MappedSpan): string {
  return JSON.stringify(span);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One outcome for a finding that has several result nodes: they must all map to one span. */
function combine(outcomes: readonly MapOutcome[]): MapOutcome {
  const [first] = outcomes;
  if (first === undefined)
    return { status: 'unmapped', reason: 'the scan found no node of this finding' };
  const unmapped = outcomes.find((o) => o.status === 'unmapped');
  if (unmapped !== undefined) return unmapped;
  const review = outcomes.find((o) => o.status === 'needs_review');
  if (review !== undefined) return review;
  const mapped = outcomes.flatMap((o) => (o.status === 'mapped' ? [o] : []));
  const spans = new Set(mapped.map((o) => spanKey(o.span)));
  if (spans.size === 1 && first.status === 'mapped') {
    return { ...first, confidence: Math.min(...mapped.map((o) => o.confidence)) };
  }
  return {
    status: 'needs_review',
    reason: `the ${String(outcomes.length)} nodes map to ${String(spans.size)} different spans`,
    candidates: mapped.map((o) => ({ span: o.span, confidence: 0.5, why: 'one of several nodes' })),
  };
}

function recordOf(finding: string, outcome: MapOutcome): MappingRecord {
  switch (outcome.status) {
    case 'mapped':
      return { finding, status: 'mapped', span: outcome.span, confidence: outcome.confidence };
    case 'needs_review':
      return { finding, status: 'needs_review' };
    case 'unmapped':
      return { finding, status: 'unmapped' };
  }
}

function paramsOf(fix: ExpectedFix): FixParams {
  const raw = fix.params ?? {};
  const label = raw['label'];
  const decorative = raw['decorative'];
  const cls = raw['visuallyHiddenClass'];
  const id = raw['id'];
  return {
    ...(isRecord(label) && typeof label['key'] === 'string' && typeof label['text'] === 'string'
      ? { label: { key: label['key'], text: label['text'] } }
      : {}),
    ...(typeof cls === 'string' ? { visuallyHiddenClass: cls } : {}),
    ...(typeof id === 'string' ? { id } : {}),
    ...(isRecord(decorative) && typeof decorative['reason'] === 'string'
      ? { decorative: { reason: decorative['reason'] } }
      : {}),
  };
}

function goldenSpan(finding: GoldenFinding): MappedSpan | null {
  const s = finding.span;
  switch (s.kind) {
    case 'element':
      return { kind: 'element', file: s.file, start: s.start, tag: s.tag };
    case 'json-value':
      return { kind: 'json-value', file: s.file, pointer: s.pointer, start: s.start, end: s.end };
    case 'css-declaration':
      return {
        kind: 'css-declaration',
        file: s.file,
        property: s.property,
        start: s.start,
        end: s.end,
      };
    case 'data':
      return null;
  }
}

function localeFiles(files: ReadonlyMap<string, string>): LocaleFile[] {
  return [...files]
    .filter(([path]) => /^locales\/[^/]+\.json$/u.test(path) && !path.endsWith('.schema.json'))
    .map(([path, source]) => ({ path, source }));
}

function mappingVerdict(
  golden: ScoredFinding,
  record: MappingRecord | undefined,
): MappingVerdict | 'not-needed' {
  if (golden.mapping === 'none') return 'not-needed';
  if (record === undefined) return 'missing';
  if (record.status === 'needs_review') return 'needs-review';
  if (record.status === 'unmapped') return 'unmapped';
  if (record.span === undefined || record.confidence === undefined) return 'unmapped';
  if (record.confidence < CONFIDENCE_THRESHOLD) return 'below-threshold';
  return spansEqual(golden.span, record.span) ? 'correct' : 'wrong-above-threshold';
}

interface Firing {
  readonly was: number;
  readonly now: number;
}

interface PageDelta {
  /** Per golden finding: result nodes that fired before and after patching, on this page. */
  readonly firing: Map<string, Firing>;
  /** Per `<rule>:<outcome>`: golden nodes that fired before and no longer fire. */
  readonly resolved: Record<string, number>;
}

/** What patching changed for the golden occurrences of one page. */
function pageDelta(before: PageResult, after: PageResult): PageDelta {
  const key = (rule: string, outcome: string, index: number): string =>
    `${rule}\u0000${outcome}\u0000${String(index)}`;
  const was = new Set(before.nodes.map((n) => key(n.rule, n.outcome, n.index)));
  const now = new Set(after.nodes.map((n) => key(n.rule, n.outcome, n.index)));
  const firing = new Map<string, Firing>();
  const resolved: Record<string, number> = {};
  for (const o of before.occurrences) {
    const wasCount = o.indices.filter((i) => was.has(key(o.rule, o.outcome, i))).length;
    const nowCount = after.occurrences
      .filter((x) => x.finding === o.finding && x.selector === o.selector)
      .flatMap((x) => x.indices)
      .filter((i) => now.has(key(o.rule, o.outcome, i))).length;
    const previous = firing.get(o.finding);
    firing.set(o.finding, {
      was: (previous?.was ?? 0) + wasCount,
      now: (previous?.now ?? 0) + nowCount,
    });
    const name = `${o.rule}:${o.outcome}`;
    resolved[name] = (resolved[name] ?? 0) + Math.max(0, wasCount - nowCount);
  }
  return { firing, resolved };
}

function joinProblems(theme: string, results: readonly PageResult[]): string[] {
  const problems: string[] = [];
  for (const r of results) {
    for (const u of r.comparison.unexpected) {
      problems.push(
        `${theme}/${r.page}: scanner finding ${u.rule}:${u.outcome} on ${u.target} has no golden finding`,
      );
    }
    for (const m of r.comparison.missing) {
      problems.push(
        `${theme}/${r.page}: golden finding ${m.finding} did not fire on ${m.selector}`,
      );
    }
    for (const c of r.comparison.countMismatch) {
      problems.push(
        `${theme}/${r.page}: ${c.finding} ${c.selector} matched ${String(c.actual)}, expected ${String(c.expected)}`,
      );
    }
  }
  return problems;
}

/** Runs one failing theme: scan, map, patch, rescan. */
export async function runTheme(
  browser: Browser,
  corpus: Corpus,
  loaded: LoadedTheme,
  options: RunOptions = {},
): Promise<ThemeRun> {
  const { entry, theme, golden, store } = loaded;
  const check = { tags: corpus.manifest.checker.tags, viewport: corpus.manifest.checker.viewport };
  const problems: string[] = [];

  // 1. Scan and join.
  const beforeResults: PageResult[] = [];
  for (const spec of entry.pages)
    beforeResults.push(await checkPage(browser, loaded.renderer, spec, golden, check));
  problems.push(...joinProblems(entry.name, beforeResults));
  const nodes = nodesByFinding(entry, beforeResults);
  const goldens = scored(entry.name, golden.findings);

  // 2. Map.
  const mapper = new Mapper(theme.files);
  const outcomes = new Map<string, MapOutcome>();
  const mapping: MappingRecord[] = [];
  for (const finding of golden.findings) {
    if (finding.mapping === 'none') continue;
    const id = `${entry.name}/${finding.id}`;
    const found = nodes.get(finding.id) ?? [];
    const outcome = combine(
      found.map((n) => mapper.map(toFinding(finding.ruleId, n, store.fixture))),
    );
    outcomes.set(finding.id, outcome);
    mapping.push(recordOf(id, outcome));
  }

  // 3. Plan the fixes.
  const edits: Edit[] = [];
  const translations = new Map<string, LocaleText>();
  const planned = new Map<string, { record: FixRecord; detail: string; edits: number }>();
  for (const finding of golden.findings) {
    const expected = finding.expectedFix;
    if (expected.channel !== 'theme-patch' || expected.outcome === 'review') continue;
    const id = `${entry.name}/${finding.id}`;
    const outcome = outcomes.get(finding.id);
    const found = nodes.get(finding.id) ?? [];
    let span: MappedSpan | null = null;
    if (options.spans === 'golden') span = goldenSpan(finding);
    else if (outcome?.status === 'mapped' && outcome.confidence >= CONFIDENCE_THRESHOLD)
      span = outcome.span;
    else if (expected.outcome === 'refused') span = goldenSpan(finding);
    if (span === null) {
      planned.set(finding.id, {
        record: { finding: id, engine: 'refusal', refusal: 'unmapped', stillFiring: true },
        detail: 'not mapped with confidence',
        edits: 0,
      });
      continue;
    }
    const measures = found.flatMap((n) => {
      const measure = contrastMeasure(n);
      return measure === undefined ? [] : [measure];
    });
    const spans = [span, ...(outcome?.status === 'mapped' ? (outcome.identical ?? []) : [])];
    const withoutRecipe = options.withoutRecipes?.includes(finding.ruleId) === true;
    const results = spans.map((s) =>
      withoutRecipe
        ? null
        : planFix({
            rule: finding.ruleId,
            span: s,
            files: theme.files,
            params: paramsOf(expected),
            ...(measures.length === 0 ? {} : { contrast: measures }),
          }),
    );
    const primary = results[0];
    if (primary === null || primary === undefined) {
      planned.set(finding.id, {
        record: { finding: id, engine: 'refusal', refusal: 'no-recipe', stillFiring: true },
        detail: `no deterministic recipe for ${finding.ruleId}`,
        edits: 0,
      });
      continue;
    }
    if (primary.kind === 'refusal') {
      planned.set(finding.id, {
        record: { finding: id, engine: 'refusal', refusal: primary.code, stillFiring: true },
        detail: primary.detail,
        edits: 0,
      });
    } else if (primary.kind === 'already-fixed') {
      planned.set(finding.id, {
        record: { finding: id, engine: 'already-fixed', stillFiring: true },
        detail: primary.reason,
        edits: 0,
      });
    } else {
      let count = 0;
      for (const r of results) {
        if (r?.kind !== 'edits') continue;
        edits.push(...r.edits);
        count += r.edits.length;
        for (const t of r.translations) {
          const known = translations.get(t.key);
          if (known !== undefined && known.text !== t.text) {
            problems.push(
              `${id}: translation key ${t.key} has two texts ("${known.text}", "${t.text}")`,
            );
          }
          translations.set(t.key, { key: t.key, text: t.text });
        }
      }
      planned.set(finding.id, {
        record: { finding: id, engine: 'edits', stillFiring: true },
        detail: primary.notes.join('; '),
        edits: count,
      });
    }
  }

  // 4. Patch the theme.
  const unique = new Map(
    edits.map((e) => [
      `${e.file}\u0000${String(e.start)}\u0000${String(e.end)}\u0000${e.replacement}`,
      e,
    ]),
  );
  const locale = localeEdits(localeFiles(theme.files), [...translations.values()]);
  let patchedFiles = new Map(theme.files);
  const diffs: Record<string, string> = {};
  if (!locale.ok) {
    problems.push(`${entry.name}: locale edits failed: ${locale.error.message}`);
  } else {
    const patch = buildPatch(theme.files, [...unique.values(), ...locale.edits]);
    if (!patch.ok) {
      problems.push(`${entry.name}: patch failed in ${patch.error.file}: ${patch.error.message}`);
    } else {
      for (const p of patch.patches) {
        patchedFiles.set(p.file, p.after);
        diffs[p.file] = p.diff;
      }
    }
  }
  if (Object.keys(diffs).length === 0) patchedFiles = new Map(theme.files);

  // 5. Theme Check.
  const newOffenses: string[] = [];
  if (Object.keys(diffs).length > 0) {
    const verdict = await validateNoNewOffenses(theme.files, patchedFiles);
    for (const o of verdict.newOffenses) newOffenses.push(`${o.file}: ${o.check}: ${o.message}`);
  }

  // 6. Re-render and rescan.
  const patchedRenderer = new ThemeRenderer(
    { name: theme.name, files: patchedFiles },
    store.objects,
  );
  const before: PageScan[] = beforeResults.map((r) => ({
    theme: entry.name,
    page: r.page,
    rendered: true,
    counts: summarizeCounts(r.nodes),
  }));
  const after: PageScan[] = [];
  const domViolations: string[] = [];
  const addedElements: Record<string, number> = {};
  const firing = new Map<string, Firing>();
  for (const [i, spec] of entry.pages.entries()) {
    const was = beforeResults[i];
    try {
      const now = await checkPage(browser, patchedRenderer, spec, golden, check);
      const delta = was === undefined ? null : pageDelta(was, now);
      if (was !== undefined) {
        const kept = additiveChanges(was.snapshot, now.snapshot);
        for (const v of kept.violations) domViolations.push(`${entry.name}/${spec.id}: ${v}`);
        addedElements[spec.id] = kept.added.length;
      }
      for (const [finding, f] of delta?.firing ?? []) {
        const prior = firing.get(finding);
        firing.set(finding, { was: (prior?.was ?? 0) + f.was, now: (prior?.now ?? 0) + f.now });
      }
      after.push({
        theme: entry.name,
        page: spec.id,
        rendered: true,
        counts: summarizeCounts(now.nodes),
        resolved: delta?.resolved ?? {},
      });
    } catch (error: unknown) {
      after.push({
        theme: entry.name,
        page: spec.id,
        rendered: false,
        error: error instanceof Error ? error.message : String(error),
        counts: {},
      });
    }
  }

  // 7. Records.
  const fixes: FixRecord[] = [];
  for (const finding of golden.findings) {
    const entryPlan = planned.get(finding.id);
    if (entryPlan === undefined) continue;
    const measured = firing.get(finding.id);
    const stillFiring = finding.engine === 'axe' ? (measured?.now ?? 0) > 0 : true;
    fixes.push({ ...entryPlan.record, stillFiring });
  }
  const mappingById = new Map(mapping.map((m) => [m.finding, m]));
  const fixById = new Map(fixes.map((f) => [f.finding, f]));
  const fixScore = scoreFixes(goldens, fixes);
  const details = golden.findings.map((finding) => {
    const id = `${entry.name}/${finding.id}`;
    const g = goldens.find((x) => x.id === id);
    const outcome = outcomes.get(finding.id);
    const record = mappingById.get(id);
    const plan = planned.get(finding.id);
    const fixRecord = fixById.get(id);
    const mappingDetail: MappingDetail = {
      status: record?.status ?? 'unmapped',
      ...(record?.confidence === undefined ? {} : { confidence: record.confidence }),
      ...(record?.span === undefined ? {} : { span: record.span }),
      why: outcome?.status === 'mapped' ? outcome.why : [],
      ...(outcome?.status === 'mapped' && outcome.rendersFrom !== undefined
        ? { rendersFrom: outcome.rendersFrom }
        : {}),
      ...(outcome !== undefined && outcome.status !== 'mapped' ? { reason: outcome.reason } : {}),
      verdict: g === undefined ? 'not-needed' : mappingVerdict(g, record),
    };
    const fixDetail: FixDetail = {
      engine: fixRecord?.engine ?? 'none',
      ...(fixRecord?.refusal === undefined ? {} : { refusal: fixRecord.refusal }),
      ...(plan === undefined ? {} : { detail: plan.detail }),
      edits: plan?.edits ?? 0,
      stillFiring: fixRecord === undefined ? null : fixRecord.stillFiring,
      verdict: fixScore.verdicts.find((v) => v.finding === id)?.verdict ?? 'review',
    };
    return {
      id,
      nodes: nodes.get(finding.id)?.length ?? 0,
      mapping: mappingDetail,
      fix: fixDetail,
    };
  });
  return {
    theme: entry.name,
    mapping,
    fixes,
    before,
    after,
    newThemeCheckOffenses: newOffenses,
    domViolations,
    addedElements,
    diffs,
    problems,
    details,
  };
}

/** Runs every failing theme and scores the corpus. */
export async function runCorpus(
  browser: Browser,
  corpus: Corpus,
  options: RunOptions = {},
): Promise<CorpusRun> {
  const goldens: ScoredFinding[] = [];
  const mapping: MappingRecord[] = [];
  const fixes: FixRecord[] = [];
  const before: PageScan[] = [];
  const after: PageScan[] = [];
  const themeCheck: { theme: string; count: number }[] = [];
  const themes: ThemeRun[] = [];
  const problems: string[] = [];
  const domViolations: string[] = [];
  const findings: FindingResult[] = [];
  for (const loaded of corpus.themes) {
    if (loaded.entry.kind !== 'failing') continue;
    const only = options.themes ?? [];
    if (only.length > 0 && !only.includes(loaded.entry.name)) continue;
    goldens.push(...scored(loaded.entry.name, loaded.golden.findings));
    const run = await runTheme(browser, corpus, loaded, options);
    themes.push(run);
    mapping.push(...run.mapping);
    fixes.push(...run.fixes);
    before.push(...run.before);
    after.push(...run.after);
    themeCheck.push({ theme: run.theme, count: run.newThemeCheckOffenses.length });
    problems.push(...run.problems);
    domViolations.push(...run.domViolations);
    for (const finding of loaded.golden.findings) {
      const id = `${loaded.entry.name}/${finding.id}`;
      const detail = run.details.find((d) => d.id === id);
      if (detail === undefined) continue;
      findings.push({
        id,
        theme: loaded.entry.name,
        ruleId: finding.ruleId,
        category: finding.category,
        targeted: finding.expectedFix.targeted,
        nodes: detail.nodes,
        mapping: detail.mapping,
        fix: detail.fix,
      });
    }
  }
  for (const store of corpus.stores)
    goldens.push(...scored(store.entry.name, store.golden.findings));
  const report = buildReport({
    mapping: scoreMapping(goldens, mapping),
    fixes: scoreFixes(goldens, fixes),
    regressions: findRegressions(before, after, themeCheck),
  });
  return { goldens, mapping, fixes, report, findings, themes, problems, domViolations };
}
