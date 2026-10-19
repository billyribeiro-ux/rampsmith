// The rule ids a golden finding may name (ADR-201): axe-core's rules in the WCAG tag set the
// scanner runs (PLAN §11, step 4), and the custom rules of `@rampsmith/a11y-rules`.
import axe from 'axe-core';
import type { Engine, Impact } from './golden.ts';

/** The tags the render audit restricts axe-core to (PLAN §11, step 4). */
export const SCANNER_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export interface KnownRule {
  readonly id: string;
  readonly engine: Engine;
  readonly criteria: readonly string[];
  /** Fixed for custom rules (their catalog); axe-core decides per node, so absent there. */
  readonly impact?: Impact;
  readonly bestPractice: boolean;
}

/**
 * The success criterion an axe-core tag names, such as `wcag143` → `1.4.3` and `wcag1412` →
 * `1.4.12`; `null` for level tags such as `wcag2aa`. Principles and guidelines are one digit
 * each in WCAG 2.2, so the remaining digits are the criterion.
 */
export function criterionFromTag(tag: string): string | null {
  const match = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
  if (match === null) return null;
  const [, principle, guideline, criterion] = match;
  if (principle === undefined || guideline === undefined || criterion === undefined) return null;
  if (criterion.startsWith('0')) return null;
  return `${principle}.${guideline}.${criterion}`;
}

/** WCAG 2.2 criteria ordered by number, so lists compare stably. */
export function sortCriteria(criteria: Iterable<string>): string[] {
  const key = (c: string): number[] => c.split('.').map(Number);
  return [...new Set(criteria)].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/** axe-core rules the scanner runs: in the scanner tags, not experimental. */
export function axeRules(): KnownRule[] {
  return axe
    .getRules([...SCANNER_TAGS])
    .filter((rule) => !rule.tags.includes('experimental'))
    .map((rule) => ({
      id: rule.ruleId,
      engine: 'axe' as const,
      criteria: sortCriteria(
        rule.tags.map(criterionFromTag).filter((c): c is string => c !== null),
      ),
      bestPractice: rule.tags.includes('best-practice'),
    }));
}

const custom = (
  id: string,
  audit: 'data' | 'browser',
  criteria: readonly string[],
  impact: Impact,
  bestPractice = false,
): KnownRule => ({
  id,
  engine: audit === 'data' ? 'rampsmith-data' : 'rampsmith-browser',
  criteria,
  impact,
  bestPractice,
});

/** The commit of `ws/a11y-rules` whose `src/rules.ts` this snapshot copies. */
export const A11Y_RULES_COMMIT = 'b79ba2f';

/**
 * Snapshot of `RULES` in `packages/a11y-rules/src/rules.ts` at {@link A11Y_RULES_COMMIT}: id,
 * audit, criteria, impact and best-practice flag. At integration this becomes an import of
 * `RULES` from `@rampsmith/a11y-rules` (docs/evidence/ws-11-corpus.md).
 */
export const CUSTOM_RULES: readonly KnownRule[] = [
  custom('rs-media-alt-empty', 'data', ['1.1.1'], 'serious'),
  custom('rs-media-alt-filename', 'data', ['1.1.1'], 'serious'),
  custom('rs-rich-text-heading-skip', 'data', ['1.3.1'], 'moderate', true),
  custom('rs-rich-text-link-empty', 'data', ['2.4.4', '4.1.2'], 'serious'),
  custom('rs-rich-text-link-vague', 'data', ['2.4.4'], 'moderate'),
  custom('rs-rich-text-img-alt-missing', 'data', ['1.1.1'], 'critical'),
  custom('rs-rich-text-img-alt-filename', 'data', ['1.1.1'], 'serious'),
  custom('rs-rich-text-table-no-headers', 'data', ['1.3.1'], 'serious'),
  custom('rs-rich-text-color-only', 'data', ['1.4.1'], 'moderate'),
  custom('rs-menu-item-label-empty', 'data', ['2.4.4', '4.1.2'], 'serious'),
  custom('rs-menu-item-label-duplicate', 'data', ['2.4.4'], 'moderate'),
  custom('rs-keyboard-trap', 'browser', ['2.1.2'], 'critical'),
  custom('rs-focus-indicator-missing', 'browser', ['2.4.7'], 'serious'),
  custom('rs-focus-stop-hidden', 'browser', ['2.4.7'], 'serious'),
  custom('rs-focus-obscured', 'browser', ['2.4.11'], 'serious'),
  custom('rs-reflow-horizontal-scroll', 'browser', ['1.4.10'], 'serious'),
  custom('rs-text-spacing-clipped', 'browser', ['1.4.12'], 'serious'),
  custom('rs-text-spacing-overlap', 'browser', ['1.4.12'], 'serious'),
  custom('rs-media-autoplay-audio', 'browser', ['1.4.2'], 'moderate'),
];

/** Every rule a golden finding may name, by id. */
export function ruleCatalog(): ReadonlyMap<string, KnownRule> {
  const all = [...axeRules(), ...CUSTOM_RULES];
  const byId = new Map<string, KnownRule>();
  for (const rule of all) {
    if (byId.has(rule.id)) throw new Error(`rule id ${rule.id} is defined twice`);
    byId.set(rule.id, rule);
  }
  return byId;
}

/** axe-core's version, as the golden files record it. */
export const AXE_VERSION: string = axe.version;
