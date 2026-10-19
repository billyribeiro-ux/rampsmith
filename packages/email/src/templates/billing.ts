/**
 * Plan and usage notices (PLAN §20). Shopify App Pricing bills the plan and sends its own
 * receipts; these emails say what changed in Rampsmith. The limits come from the entitlements
 * function in `crates/billing` (ADR-131 to ADR-134), passed in, never restated here.
 */
import { count, instant, int, label, link, object, oneOf, optional, refine } from '../schema.ts';
import type { MessageKey } from '../translator.ts';
import { action, COMMON, defineTemplate, facts, msg, paragraph } from '../template.ts';
import { STORE_NAME_MAX } from './store.ts';

const PLANS = ['free', 'starter', 'growth', 'pro'] as const;
type Plan = (typeof PLANS)[number];

const PLAN_NAMES: Readonly<Record<Plan, MessageKey>> = {
  free: 'plan_free',
  starter: 'plan_starter',
  growth: 'plan_growth',
  pro: 'plan_pro',
};

const CADENCES = ['monthly', 'weekly', 'daily'] as const;
type Cadence = (typeof CADENCES)[number];

const CADENCE_NAMES: Readonly<Record<Cadence, MessageKey>> = {
  monthly: 'cadence_monthly',
  weekly: 'cadence_weekly',
  daily: 'cadence_daily',
};

/** Matches `billing::DraftAllowance`: a lifetime allowance (Free) or a monthly one. */
const PERIODS = ['lifetime', 'monthly'] as const;

export const planChanged = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    storeName: label(STORE_NAME_MAX),
    plan: oneOf(PLANS),
    previousPlan: oneOf(PLANS),
    effectiveAt: instant(),
    scanCadence: oneOf(CADENCES),
    altTextDrafts: object({ limit: count(), period: oneOf(PERIODS) }),
    planUrl: link(['shopifyAdmin', 'app']),
  }),
  build(input, t) {
    const store = input.storeName;
    const plan = t.text(PLAN_NAMES[input.plan]);
    const drafts = input.altTextDrafts;
    return {
      subject: t.text('plan_changed_subject', { plan }),
      preheader: t.text('plan_changed_preheader', { plan, store }),
      title: t.text('plan_changed_title', { plan }),
      blocks: [
        paragraph(
          msg(t, 'plan_changed_intro', {
            store,
            previous: t.text(PLAN_NAMES[input.previousPlan]),
            plan,
            date: t.date(input.effectiveAt),
          }),
        ),
        facts([
          {
            label: msg(t, 'plan_changed_scans_label'),
            value: msg(t, CADENCE_NAMES[input.scanCadence]),
          },
          {
            label: msg(t, 'plan_changed_drafts_label'),
            value:
              drafts.period === 'monthly'
                ? msg(t, 'plan_changed_drafts_monthly', { count: drafts.limit })
                : msg(t, 'plan_changed_drafts_lifetime', { count: drafts.limit }),
          },
        ]),
        paragraph(msg(t, 'plan_changed_billing')),
        action(t, t.text('plan_changed_button'), input.planUrl, false),
      ],
      reason: msg(t, 'common_reason_store_contact', { store }),
    };
  },
});

const RESOURCES = ['alt_text_drafts'] as const;

export const usageLimit = defineTemplate({
  category: 'transactional',
  schema: refine(
    object({
      ...COMMON,
      storeName: label(STORE_NAME_MAX),
      resource: oneOf(RESOURCES),
      used: count(),
      limit: int(1, 1_000_000_000),
      state: oneOf(['approaching', 'reached'] as const),
      /** When the allowance renews; absent for a lifetime allowance. */
      resetsAt: optional(instant()),
      planUrl: link(['shopifyAdmin', 'app']),
    }),
    (v) => v.used <= v.limit,
    'used',
    'must not exceed limit',
  ),
  build(input, t) {
    const store = input.storeName;
    const params = { store, used: input.used, limit: input.limit };
    const reached = input.state === 'reached';
    const blocks = [
      paragraph(
        msg(t, reached ? 'usage_drafts_reached_intro' : 'usage_drafts_approaching_intro', params),
      ),
    ];
    if (reached) {
      blocks.push(
        paragraph(
          input.resetsAt === undefined
            ? msg(t, 'usage_drafts_paused_lifetime')
            : msg(t, 'usage_drafts_paused_until', { date: t.date(input.resetsAt) }),
        ),
      );
    } else if (input.resetsAt !== undefined) {
      blocks.push(paragraph(msg(t, 'usage_drafts_renews', { date: t.date(input.resetsAt) })));
    }
    blocks.push(
      facts([
        {
          label: msg(t, 'usage_drafts_used_label'),
          value: msg(t, 'usage_drafts_used_value', { used: input.used, limit: input.limit }),
        },
      ]),
      paragraph(msg(t, 'usage_unaffected')),
      action(t, t.text('usage_button'), input.planUrl, false),
    );
    return {
      subject: t.text(
        reached ? 'usage_drafts_reached_subject' : 'usage_drafts_approaching_subject',
        params,
      ),
      preheader: t.text('usage_preheader'),
      title: t.text(reached ? 'usage_drafts_reached_title' : 'usage_drafts_approaching_title'),
      blocks,
      reason: msg(t, 'common_reason_store_contact', { store }),
    };
  },
});
