/**
 * The three Claude models Rampsmith routes to (PLAN §13), with the facts the code depends on.
 * Every value was read on 2026-10-17 from the official documentation and is recorded with
 * its link in ADR-212:
 * - ids, context, output limits: https://platform.claude.com/docs/en/models/overview
 * - prices: https://platform.claude.com/docs/en/about-claude/pricing
 * - thinking and effort: https://platform.claude.com/docs/en/build-with-claude/effort
 * - retirement: https://platform.claude.com/docs/en/about-claude/model-deprecations
 *
 * For the 4.6 generation and later a dateless id is a pinned snapshot, not an alias, so these
 * ids never change behaviour under us (model-ids-and-versions).
 */

export type ModelId = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * How a model may think. `disabled` exists only on Haiku 5.5 and `between_tools` (no up-front
 * thinking) only on Sonnet 5.5, both at effort `high` or below; Opus 5.5 always thinks.
 */
export type ThinkingMode = 'adaptive' | 'disabled' | 'between_tools';

/** Prices in micro-dollars (µ$) per million tokens. */
export interface PriceTier {
  /** Highest prompt length, in tokens, this tier applies to. */
  readonly maxPromptTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
}

export interface ModelSpec {
  readonly id: ModelId;
  readonly maxOutputTokens: number;
  /** The default effort when the request omits it. */
  readonly defaultEffort: Effort;
  readonly thinkingModes: readonly ThinkingMode[];
  /** Prompts shorter than this are processed without caching, with no error. */
  readonly minCacheTokens: number;
  /** High-resolution vision tier: 2576 px long edge, 4784 visual tokens. */
  readonly image: { readonly maxLongEdge: number; readonly maxTokens: number };
  /** "Not sooner than" retirement date on the deprecations page. */
  readonly retiresNotBefore: string;
  /** Ordered by `maxPromptTokens`; the last tier is unbounded. */
  readonly prices: readonly PriceTier[];
}

const HIGH_RES_IMAGE = { maxLongEdge: 2576, maxTokens: 4784 } as const;

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    maxOutputTokens: 128_000,
    defaultEffort: 'medium',
    thinkingModes: ['adaptive', 'disabled'],
    minCacheTokens: 512,
    image: HIGH_RES_IMAGE,
    retiresNotBefore: '2027-10-07',
    prices: [
      {
        maxPromptTokens: 100_000,
        input: 100_000,
        output: 500_000,
        cacheWrite5m: 125_000,
        cacheWrite1h: 200_000,
        cacheRead: 10_000,
      },
      {
        maxPromptTokens: Number.POSITIVE_INFINITY,
        input: 500_000,
        output: 2_500_000,
        cacheWrite5m: 625_000,
        cacheWrite1h: 1_000_000,
        cacheRead: 50_000,
      },
    ],
  },
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    maxOutputTokens: 128_000,
    defaultEffort: 'high',
    thinkingModes: ['adaptive', 'between_tools'],
    minCacheTokens: 512,
    image: HIGH_RES_IMAGE,
    retiresNotBefore: '2027-09-28',
    prices: [
      {
        maxPromptTokens: Number.POSITIVE_INFINITY,
        input: 2_000_000,
        output: 10_000_000,
        cacheWrite5m: 2_500_000,
        cacheWrite1h: 4_000_000,
        cacheRead: 100_000,
      },
    ],
  },
  'claude-opus-5-5': {
    id: 'claude-opus-5-5',
    maxOutputTokens: 128_000,
    defaultEffort: 'medium',
    thinkingModes: ['adaptive'],
    minCacheTokens: 512,
    image: HIGH_RES_IMAGE,
    retiresNotBefore: '2027-09-22',
    prices: [
      {
        maxPromptTokens: Number.POSITIVE_INFINITY,
        input: 4_000_000,
        output: 20_000_000,
        cacheWrite5m: 5_000_000,
        cacheWrite1h: 8_000_000,
        cacheRead: 200_000,
      },
    ],
  },
};

/** The Batch API halves every price category; caching multipliers stack with it. */
export const BATCH_DISCOUNT_DIVISOR = 2;

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

/**
 * The price tier for a request whose prompt (uncached input plus cache reads and writes)
 * has `promptTokens` tokens. Each request is priced on its own.
 */
export function priceTier(model: ModelId, promptTokens: number): PriceTier {
  const tiers = MODELS[model].prices;
  const tier = tiers.find((t) => promptTokens <= t.maxPromptTokens) ?? tiers.at(-1);
  if (tier === undefined) {
    throw new Error(`no price tier for ${model}`);
  }
  return tier;
}

/** Effort levels at which a non-adaptive thinking mode is accepted (effort docs). */
const NON_ADAPTIVE_EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/** Whether the API accepts this thinking mode at this effort on this model. */
export function acceptsThinking(model: ModelId, mode: ThinkingMode, effort: Effort): boolean {
  if (!MODELS[model].thinkingModes.includes(mode)) {
    return false;
  }
  return mode === 'adaptive' || NON_ADAPTIVE_EFFORTS.includes(effort);
}
