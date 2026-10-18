// Semantic checks of a golden file beyond its JSON Schema (corpus/CONTRACT.md, "Checks"):
// rule ids are known and match their engine and criteria, pages exist, spans exist, and the
// expected fix fits the span and the R2 fix-rate rules.
import {
  TOP_SIX_CATEGORIES,
  type GoldenFile,
  type GoldenFinding,
  type RecipeName,
  type Span,
} from './golden.ts';
import type { Manifest } from './manifest.ts';
import type { StoreFixture } from './render/store.ts';
import type { Theme } from './render/theme.ts';
import type { KnownRule } from './rules.ts';
import { sortCriteria } from './rules.ts';
import { spanProblem } from './spans.ts';

/** Recipes whose fixes count toward R2's fix rate: deterministic, in the six top categories. */
export const TARGETABLE_RECIPES: readonly RecipeName[] = [
  'contrast',
  'image-alt',
  'form-label',
  'empty-link',
  'empty-button',
  'document-language',
];

export interface GoldenContext {
  readonly manifest: Manifest;
  readonly catalog: ReadonlyMap<string, KnownRule>;
  readonly theme: Theme | null;
  readonly pages: readonly string[];
  readonly store: StoreFixture | null;
}

/** Which span a recipe can act on: element tags, or other span kinds. */
function recipeFitsSpan(recipe: RecipeName, span: Span): string | null {
  const element = (tags: readonly string[], where?: RegExp): string | null => {
    if (span.kind !== 'element') return `${recipe} acts on an element span, not ${span.kind}`;
    if (!tags.includes(span.tag))
      return `${recipe} acts on ${tags.map((t) => `<${t}>`).join(', ')}, not <${span.tag}>`;
    if (where !== undefined && !where.test(span.file))
      return `${recipe} acts on ${String(where)}, not ${span.file}`;
    return null;
  };
  const layout = /^layout\/[^/]+\.liquid$/;
  switch (recipe) {
    case 'document-language':
      return element(['html'], layout);
    case 'skip-link':
      return element(['body'], layout);
    case 'empty-link':
      return element(['a']);
    case 'empty-button':
      return element(['button']);
    case 'form-label':
      return element(['input', 'select', 'textarea']);
    case 'image-alt':
      return element(['img']);
    case 'contrast':
      return span.kind === 'json-value' || span.kind === 'css-declaration'
        ? null
        : 'contrast acts on a colour setting or a CSS declaration';
    case 'focus-visible':
      return span.kind === 'css-declaration' ? null : 'focus-visible acts on a CSS declaration';
    case 'target-size':
      return span.kind === 'css-declaration' || span.kind === 'element'
        ? null
        : 'target-size acts on an element or a CSS declaration';
    case 'media-alt':
      return span.kind === 'data' && span.field === 'alt' && span.resource.includes('/MediaImage/')
        ? null
        : 'media-alt acts on a MediaImage alt field';
    case 'rich-text':
      return span.kind === 'data' ? null : 'rich-text acts on store data';
    case 'ai-proposal':
      return null;
  }
}

function findingProblems(finding: GoldenFinding, context: GoldenContext): string[] {
  const problems: string[] = [];
  const rule = context.catalog.get(finding.ruleId);
  if (rule === undefined) {
    problems.push(`rule ${finding.ruleId} is not a known axe-core or custom rule`);
  } else {
    if (rule.engine !== finding.engine) {
      problems.push(
        `rule ${finding.ruleId} belongs to engine ${rule.engine}, not ${finding.engine}`,
      );
    }
    const want = sortCriteria(rule.criteria).join(',');
    const got = sortCriteria(finding.criteria).join(',');
    if (want !== got) problems.push(`criteria are ${got}; rule ${finding.ruleId} has ${want}`);
    if (rule.impact !== undefined && rule.impact !== finding.impact) {
      problems.push(`impact is ${finding.impact}; rule ${finding.ruleId} has ${rule.impact}`);
    }
  }
  for (const occurrence of finding.occurrences ?? []) {
    if (occurrence.page !== '*' && !context.pages.includes(occurrence.page)) {
      problems.push(`occurrence page ${occurrence.page} is not a page of the theme`);
    }
  }
  const spanIssue = spanProblem(finding.span, context.theme, context.store);
  if (spanIssue !== null) problems.push(`span: ${spanIssue}`);
  if (finding.rendersFrom !== undefined) {
    const issue = spanProblem(finding.rendersFrom, context.theme, context.store);
    if (issue !== null) problems.push(`rendersFrom: ${issue}`);
  }
  const fix = finding.expectedFix;
  const fit = recipeFitsSpan(fix.recipe, finding.span);
  if (fit !== null) problems.push(`expectedFix: ${fit}`);
  if (fix.targeted) {
    if (!TOP_SIX_CATEGORIES.includes(finding.category)) {
      problems.push(
        `a targeted finding must be in the six top categories, not ${finding.category}`,
      );
    }
    if (!TARGETABLE_RECIPES.includes(fix.recipe)) {
      problems.push(
        `recipe ${fix.recipe} is not a deterministic recipe for the six top categories`,
      );
    }
    if (finding.mapping !== 'deterministic') {
      problems.push('a targeted finding must map deterministically');
    }
  }
  if (fix.channel === 'admin-api' && finding.span.kind !== 'data') {
    problems.push('an Admin API fix needs a data span');
  }
  if (fix.channel === 'theme-patch' && finding.span.kind === 'data') {
    problems.push('a theme patch cannot fix store data');
  }
  return problems;
}

/** Every problem with a golden file, as `<subject>/<finding>: message`. */
export function verifyGolden(file: GoldenFile, context: GoldenContext): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const finding of file.findings) {
    const where = `${file.subject}/${finding.id}`;
    if (seen.has(finding.id)) problems.push(`${where}: the id is used twice`);
    seen.add(finding.id);
    for (const problem of findingProblems(finding, context)) problems.push(`${where}: ${problem}`);
  }
  return problems;
}
