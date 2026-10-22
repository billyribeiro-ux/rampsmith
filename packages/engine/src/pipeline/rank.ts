/**
 * Ranking and fix classification of findings (PLAN §11 "Priority score"; ADR-072).
 *
 * score = impact weight (critical 8, serious 4, moderate 2, minor 1) × templates affected ×
 * 2 on a purchase path. Ties break on how common the failure is on the web (WebAIM Million 2026,
 * PLAN §12), then on how easily it is fixed (a data fix, then a code recipe, then by hand), then
 * on the rule id, so the order is total and stable. The formula is printed in the app's help,
 * so the ranking is never a black box.
 */
import { PURCHASE_PATH, type PageType } from './vocab.ts';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
type FixKind = 'data' | 'code' | 'manual';

const IMPACT_WEIGHT: Readonly<Record<Impact, number>> = {
  critical: 8,
  serious: 4,
  moderate: 2,
  minor: 1,
};

/**
 * Share of the top million home pages with the failure (WebAIM Million 2026, February 2026;
 * PLAN §12), by axe-core rule. A rule not listed has prevalence 0.
 */
const PREVALENCE: Readonly<Record<string, number>> = {
  'color-contrast': 83.9,
  'image-alt': 53.1,
  label: 51.0,
  'link-name': 46.3,
  'button-name': 30.6,
  'html-has-lang': 13.5,
  'html-lang-valid': 13.5,
};

/** How a rule's findings are fixed: the recipe name of `packages/liquid-patch` or the data fix. */
export interface Fixability {
  readonly kind: FixKind;
  readonly recipe: string | null;
}

const CODE_RECIPES: Readonly<Record<string, string>> = {
  'color-contrast': 'contrast',
  'image-alt': 'image-alt',
  label: 'form-label',
  'select-name': 'form-label',
  'link-name': 'empty-link',
  'button-name': 'empty-button',
  'html-has-lang': 'document-language',
  'html-lang-valid': 'document-language',
  bypass: 'skip-link',
  'rs-focus-indicator-missing': 'focus-visible',
  'target-size': 'target-size',
};

const DATA_RECIPES: Readonly<Record<string, string>> = {
  'rs-media-alt-empty': 'media-alt',
  'rs-media-alt-filename': 'media-alt',
  'rs-menu-item-label-empty': 'menu-label',
  'rs-menu-item-label-duplicate': 'menu-label',
};

export function fixabilityOf(ruleId: string, origin: 'render' | 'data'): Fixability {
  if (origin === 'data') {
    return { kind: 'data', recipe: DATA_RECIPES[ruleId] ?? 'rich-text' };
  }
  const recipe = CODE_RECIPES[ruleId];
  return recipe === undefined ? { kind: 'manual', recipe: null } : { kind: 'code', recipe };
}

const KIND_ORDER: Readonly<Record<FixKind, number>> = { data: 0, code: 1, manual: 2 };

export interface Rankable {
  readonly id: string;
  readonly ruleId: string;
  readonly impact: Impact;
  /** The page types the finding was seen on (data findings: the types they show on). */
  readonly pageTypes: readonly PageType[];
  /** Distinct template variants the finding was seen on; at least the page types. */
  readonly templates: number;
  readonly origin: 'render' | 'data';
  /** A data finding on a product's media or text sits on the purchase path. */
  readonly onPurchasePath: boolean;
}

export interface Ranked {
  readonly id: string;
  readonly score: number;
  readonly templatesAffected: number;
  readonly onPurchasePath: boolean;
  readonly fix: Fixability;
}

/** The score of one finding. */
export function scoreOf(
  impact: Impact,
  templatesAffected: number,
  onPurchasePath: boolean,
): number {
  return IMPACT_WEIGHT[impact] * Math.max(1, templatesAffected) * (onPurchasePath ? 2 : 1);
}

function isPurchasePath(pageTypes: readonly PageType[]): boolean {
  return pageTypes.some((t) => PURCHASE_PATH.has(t));
}

/** Ranks findings, best first. Returns each finding's score, reach and fixability. */
export function rank(findings: readonly Rankable[]): Ranked[] {
  const scored = findings.map((f) => {
    const templatesAffected = Math.max(1, f.templates, f.pageTypes.length);
    const onPurchasePath = f.onPurchasePath || isPurchasePath(f.pageTypes);
    return {
      f,
      ranked: {
        id: f.id,
        score: scoreOf(f.impact, templatesAffected, onPurchasePath),
        templatesAffected,
        onPurchasePath,
        fix: fixabilityOf(f.ruleId, f.origin),
      } satisfies Ranked,
    };
  });
  scored.sort(
    (a, b) =>
      b.ranked.score - a.ranked.score ||
      (PREVALENCE[b.f.ruleId] ?? 0) - (PREVALENCE[a.f.ruleId] ?? 0) ||
      KIND_ORDER[a.ranked.fix.kind] - KIND_ORDER[b.ranked.fix.kind] ||
      a.f.ruleId.localeCompare(b.f.ruleId) ||
      a.f.id.localeCompare(b.f.id),
  );
  return scored.map((s) => s.ranked);
}
