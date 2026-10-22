/**
 * The four plans of PLAN §20 as amended by ADR-141, as data. `plans.test.ts` reads the table
 * from `docs/PLAN.md` and fails when the two disagree, so the pricing page cannot drift from the
 * plan the founder approved on 17 October 2026.
 */

export type PlanId = 'free' | 'starter' | 'growth' | 'pro';

export interface Plan {
  readonly id: PlanId;
  /** US dollars a month, billed through Shopify App Pricing. */
  readonly monthly: number;
  /** US dollars a year: ten months' price, so two months are free. */
  readonly yearly: number;
  /** Alt-text drafts per month; Free gets 25 once, not monthly. */
  readonly altTextDrafts: number;
  readonly altTextRecurs: boolean;
}

export const PLANS: readonly Plan[] = [
  { id: 'free', monthly: 0, yearly: 0, altTextDrafts: 25, altTextRecurs: false },
  { id: 'starter', monthly: 79, yearly: 790, altTextDrafts: 2000, altTextRecurs: true },
  { id: 'growth', monthly: 199, yearly: 1990, altTextDrafts: 10_000, altTextRecurs: true },
  { id: 'pro', monthly: 499, yearly: 4990, altTextDrafts: 50_000, altTextRecurs: true },
];

const ORDER: readonly PlanId[] = ['free', 'starter', 'growth', 'pro'];

/** A capability that some plans have and others show as locked. */
export type FeatureId =
  | 'scans'
  | 'data_fixes'
  | 'core_prs'
  | 'all_recipes'
  | 'rewrites'
  | 'alerts'
  | 'custom_widgets'
  | 'languages'
  | 'priority';

/** The first plan that includes each gated feature; the plans above it include it too. */
const FEATURE_FROM: Readonly<Record<FeatureId, PlanId>> = {
  scans: 'free',
  data_fixes: 'free',
  core_prs: 'starter',
  all_recipes: 'growth',
  rewrites: 'growth',
  alerts: 'growth',
  custom_widgets: 'pro',
  languages: 'pro',
  priority: 'pro',
};

export const FEATURES: readonly FeatureId[] = Object.keys(FEATURE_FROM) as FeatureId[];

export function includes(plan: PlanId, feature: FeatureId): boolean {
  return ORDER.indexOf(plan) >= ORDER.indexOf(FEATURE_FROM[feature]);
}

/** The cheapest plan that unlocks a feature, for the label on a locked row. */
export function unlockedBy(feature: FeatureId): PlanId {
  return FEATURE_FROM[feature];
}

export function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}
