/**
 * From a store's findings to a reviewable set of fixes (PLAN §12, §15; ADR-295): the mapper finds
 * each finding's source, the planner runs its recipe, and this module turns the results into an
 * ordered list of fixes whose edits apply together, with the file contents after each one (a
 * commit per fix, ADR-141) and Theme Check run on the result.
 *
 * It is pure: files in, a plan out. Nothing is read from the network, a browser or the clock, so
 * the corpus runner, the engine job and the tests all run the same code, and the same input
 * always gives the same plan.
 *
 * Every fix that is not made says why, with a code and no finding text: a finding the mapper is
 * not sure of is reported, never guessed at (PLAN §12).
 */
import { applyEdits, type Edit } from './edits.ts';
import { unifiedDiff } from './diff.ts';
import { Mapper } from './map/map.ts';
import {
  CONFIDENCE_THRESHOLD,
  type ElementSpan,
  type MapEvidence,
  type MapOutcome,
  type MappedSpan,
  type RenderedElement,
  type RenderedResource,
} from './map/types.ts';
import { hasRecipe, planFix, type ContrastEvidence, type FixParams } from './plan.ts';
import { localeEdits, type LocaleFile, type LocaleText } from './translations.ts';
import { validateNoNewOffenses } from './theme-check.ts';

/** One place a finding was seen, as the scanner described it. */
export interface BatchNode {
  readonly element: RenderedElement;
  /** The page's JSON template when it differs from the finding's. */
  readonly template?: string;
  readonly evidence?: MapEvidence;
  /** What axe-core measured, for `color-contrast`. */
  readonly contrast?: ContrastEvidence;
  readonly resource?: RenderedResource;
}

export interface BatchFinding {
  /** The caller's id for the finding (the findings row id). */
  readonly id: string;
  /** The rule that fired (an axe-core rule id). */
  readonly rule: string;
  /** The JSON template of the pages it was seen on, such as `product` or `index`. */
  readonly template: string;
  readonly nodes: readonly BatchNode[];
  /** What the person brought for this finding: an accessible name, a decorative reason. */
  readonly params?: FixParams;
}

export interface BatchOptions {
  /** Whether the plan includes the recipes that change colours (`every_recipe`, ADR-141). */
  readonly contrast: boolean;
  /** Most nodes of one finding that are mapped; the rest are assumed to agree. Default 5. */
  readonly maxNodes?: number;
}

export type SkipCode =
  /** The rule has no deterministic recipe. */
  | 'no-recipe'
  /** The recipe is not part of the store's plan. */
  | 'plan'
  /** The mapper found no source. */
  | 'unmapped'
  /** The mapper is not sure enough to act without a person (below 0.9, or several candidates). */
  | 'needs-review'
  /** The fix is a change to store data, made through the Admin API, not in the theme. */
  | 'data'
  /** The recipe refused (its typed code is in the detail). */
  | 'refused'
  /** The theme already has the fix. */
  | 'already-fixed'
  /** Its edits overlap an earlier fix's, or its translation disagrees with one. */
  | 'conflict'
  /** Theme Check reports an offense the fix would add. */
  | 'theme-check';

export interface Skipped {
  readonly findingId: string;
  readonly code: SkipCode;
  /** Rampsmith's own words: a code, a refusal code, a file name. Never page text. */
  readonly detail: string;
}

export interface PlannedFix {
  readonly findingId: string;
  readonly rule: string;
  /** The lowest mapping confidence among the nodes. */
  readonly confidence: number;
  readonly notes: readonly string[];
  readonly edits: readonly Edit[];
  readonly translations: readonly LocaleText[];
}

/** What one fix changed in one file, on top of the fixes before it. */
export interface StepFile {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
}

export interface BatchStep {
  readonly fix: PlannedFix;
  /** 1-based position among the batch's commits. */
  readonly ordinal: number;
  readonly files: readonly StepFile[];
}

export interface BatchPlan {
  readonly steps: readonly BatchStep[];
  readonly skipped: readonly Skipped[];
  /** The theme after every step. */
  readonly final: ReadonlyMap<string, string>;
}

function spanKey(span: MappedSpan): string {
  return JSON.stringify(span);
}

/** Every span an outcome puts the same fix on: its own and the mapper's identical twins. */
function group(outcome: Extract<MapOutcome, { status: 'mapped' }>): Set<string> {
  return new Set([outcome.span, ...(outcome.identical ?? [])].map(spanKey));
}

/**
 * One outcome for a finding with several nodes. The nodes must agree: each maps to the same set
 * of spans (a header link and its hidden mobile twin map to each other, so a finding that holds
 * both is one fix).
 */
function combine(outcomes: readonly MapOutcome[]): MapOutcome {
  const [first] = outcomes;
  if (first === undefined) return { status: 'unmapped', reason: 'no node of this finding' };
  const unmapped = outcomes.find((o) => o.status === 'unmapped');
  if (unmapped !== undefined) return unmapped;
  const review = outcomes.find((o) => o.status === 'needs_review');
  if (review !== undefined) return review;
  const mapped = outcomes.flatMap((o) => (o.status === 'mapped' ? [o] : []));
  const reference = mapped[0] === undefined ? new Set<string>() : group(mapped[0]);
  const agree = mapped.every((o) => {
    const g = group(o);
    return g.size === reference.size && [...g].every((k) => reference.has(k));
  });
  if (agree && first.status === 'mapped') {
    return { ...first, confidence: Math.min(...mapped.map((o) => o.confidence)) };
  }
  return {
    status: 'needs_review',
    reason: `the nodes map to different spans`,
    candidates: [],
  };
}

function editKey(e: Edit): string {
  return `${e.file}\u0000${String(e.start)}\u0000${String(e.end)}\u0000${e.replacement}`;
}

function uniqueEdits(edits: readonly Edit[]): Edit[] {
  return [...new Map(edits.map((e) => [editKey(e), e])).values()];
}

/** Code-unit order, the same on every machine. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function localeFiles(files: ReadonlyMap<string, string>): LocaleFile[] {
  return [...files]
    .filter(([path]) => /^locales\/[^/]+\.json$/u.test(path) && !path.endsWith('.schema.json'))
    .map(([path, source]) => ({ path, source }));
}

interface Candidate {
  readonly fix: PlannedFix;
}

function planFinding(
  mapper: Mapper,
  files: ReadonlyMap<string, string>,
  finding: BatchFinding,
  options: BatchOptions,
): Candidate | Skipped {
  const skip = (code: SkipCode, detail: string): Skipped => ({
    findingId: finding.id,
    code,
    detail,
  });
  if (!hasRecipe(finding.rule)) return skip('no-recipe', finding.rule);
  if (finding.rule === 'color-contrast' && !options.contrast) {
    return skip('plan', 'color-contrast');
  }
  const nodes = finding.nodes.slice(0, options.maxNodes ?? 5);
  if (nodes.length === 0) return skip('unmapped', 'the finding has no node');
  const outcome = combine(
    nodes.map((n) =>
      mapper.map({
        rule: finding.rule,
        template: n.template ?? finding.template,
        element: n.element,
        ...(n.evidence === undefined ? {} : { evidence: n.evidence }),
        ...(n.resource === undefined ? {} : { resource: n.resource }),
      }),
    ),
  );
  if (outcome.status === 'unmapped') return skip('unmapped', 'no source element fits');
  if (outcome.status === 'needs_review') return skip('needs-review', 'several sources fit');
  if (outcome.confidence < CONFIDENCE_THRESHOLD) {
    return skip('needs-review', `confidence ${outcome.confidence.toFixed(2)}`);
  }
  if (outcome.span.kind === 'data') return skip('data', outcome.span.field);
  const spans: MappedSpan[] = [
    outcome.span,
    ...(outcome.identical ?? ([] as readonly ElementSpan[])),
  ];
  const measures = nodes.flatMap((n) => (n.contrast === undefined ? [] : [n.contrast]));
  const results = spans.map((span) =>
    planFix({
      rule: finding.rule,
      span,
      files,
      ...(finding.params === undefined ? {} : { params: finding.params }),
      ...(measures.length === 0 ? {} : { contrast: measures }),
    }),
  );
  const [primary] = results;
  if (primary === null || primary === undefined) return skip('no-recipe', finding.rule);
  if (primary.kind === 'refusal') return skip('refused', primary.code);
  if (primary.kind === 'already-fixed') return skip('already-fixed', finding.rule);
  const edits: Edit[] = [];
  const translations = new Map<string, LocaleText>();
  const notes: string[] = [];
  for (const result of results) {
    if (result?.kind !== 'edits') continue;
    edits.push(...result.edits);
    notes.push(...result.notes);
    for (const t of result.translations) translations.set(t.key, { key: t.key, text: t.text });
  }
  return {
    fix: {
      findingId: finding.id,
      rule: finding.rule,
      confidence: outcome.confidence,
      notes: [...new Set(notes)],
      edits: uniqueEdits(edits),
      translations: [...translations.values()],
    },
  };
}

/** Applies fixes cumulatively; a fix that cannot be added is skipped, not forced. */
function assemble(
  files: ReadonlyMap<string, string>,
  fixes: readonly PlannedFix[],
): { steps: BatchStep[]; skipped: Skipped[]; final: Map<string, string> } {
  const steps: BatchStep[] = [];
  const skipped: Skipped[] = [];
  const accepted: PlannedFix[] = [];
  let current = new Map(files);
  const locales = localeFiles(files);
  for (const fix of fixes) {
    const trial = [...accepted, fix];
    const texts = new Map<string, LocaleText>();
    let clash: string | null = null;
    for (const t of trial.flatMap((f) => f.translations)) {
      const known = texts.get(t.key);
      if (known !== undefined && known.text !== t.text) clash = t.key;
      texts.set(t.key, t);
    }
    if (clash !== null) {
      skipped.push({ findingId: fix.findingId, code: 'conflict', detail: `translation ${clash}` });
      continue;
    }
    const locale = localeEdits(locales, [...texts.values()]);
    if (!locale.ok) {
      skipped.push({
        findingId: fix.findingId,
        code: 'conflict',
        detail: `locale: ${locale.error.code}`,
      });
      continue;
    }
    const edits = uniqueEdits([...trial.flatMap((f) => f.edits), ...locale.edits]);
    const next = new Map(files);
    let failed: string | null = null;
    const byFile = new Map<string, Edit[]>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, list] of [...byFile].sort(([a], [b]) => compare(a, b))) {
      const source = files.get(file);
      if (source === undefined) {
        failed = `${file} is not in the theme`;
        break;
      }
      const result = applyEdits(source, list);
      if (!result.ok) {
        failed = `${file}: ${result.error.code}`;
        break;
      }
      next.set(file, result.contents);
    }
    if (failed !== null) {
      skipped.push({ findingId: fix.findingId, code: 'conflict', detail: failed });
      continue;
    }
    const changed: StepFile[] = [];
    for (const [file, after] of [...next].sort(([a], [b]) => compare(a, b))) {
      const before = current.get(file);
      if (before !== undefined && before !== after) {
        changed.push({ file, before, after, diff: unifiedDiff(file, before, after) });
      }
    }
    if (changed.length === 0) {
      skipped.push({ findingId: fix.findingId, code: 'already-fixed', detail: 'no change' });
      continue;
    }
    accepted.push(fix);
    steps.push({ fix, ordinal: steps.length + 1, files: changed });
    current = next;
  }
  return { steps, skipped, final: current };
}

/**
 * Plans the fixes for `findings` on the theme `files` (theme-relative path to contents).
 *
 * Fixes are ordered by rule, then finding id, so the same input gives the same commits. Theme
 * Check runs on the result; if it reports an offense the fixes add, each fix is tried alone and
 * the ones that add offenses are dropped.
 */
export async function planBatch(
  files: ReadonlyMap<string, string>,
  findings: readonly BatchFinding[],
  options: BatchOptions,
): Promise<BatchPlan> {
  const mapper = new Mapper(files);
  const skipped: Skipped[] = [];
  const candidates: PlannedFix[] = [];
  const ordered = [...findings].sort((a, b) => compare(a.rule, b.rule) || compare(a.id, b.id));
  for (const finding of ordered) {
    const result = planFinding(mapper, files, finding, options);
    if ('fix' in result) candidates.push(result.fix);
    else skipped.push(result);
  }

  let built = assemble(files, candidates);
  skipped.push(...built.skipped);
  if (built.steps.length > 0) {
    const verdict = await validateNoNewOffenses(files, built.final);
    if (!verdict.ok) {
      const keep: PlannedFix[] = [];
      for (const step of built.steps) {
        const alone = assemble(files, [step.fix]);
        const check = await validateNoNewOffenses(files, alone.final);
        if (check.ok) keep.push(step.fix);
        else {
          skipped.push({
            findingId: step.fix.findingId,
            code: 'theme-check',
            detail: [...new Set(check.newOffenses.map((o) => o.check))].join(', '),
          });
        }
      }
      built = assemble(files, keep);
      skipped.push(...built.skipped);
      if (built.steps.length > 0) {
        const again = await validateNoNewOffenses(files, built.final);
        if (!again.ok) {
          for (const step of built.steps) {
            skipped.push({
              findingId: step.fix.findingId,
              code: 'theme-check',
              detail: 'the fixes together add an offense',
            });
          }
          built = { steps: [], skipped: [], final: new Map(files) };
        }
      }
    }
  }
  return { steps: built.steps, skipped, final: built.final };
}
