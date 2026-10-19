import { describe, expect, it } from 'vitest';
import {
  costMicroUsd,
  estimateTextTokens,
  imageTokens,
  planImageResize,
  worstCaseCostMicroUsd,
} from '../src/cost.ts';
import { MODELS, priceTier } from '../src/models.ts';

describe('image tokens (vision docs: ⌈w/28⌉ × ⌈h/28⌉)', () => {
  it('matches the documented examples', () => {
    expect(imageTokens(200, 200)).toBe(64);
    expect(imageTokens(1000, 1000)).toBe(1296);
    expect(imageTokens(1092, 1092)).toBe(1521);
    // A 1920×1080 image on the high-resolution tier is not resized: 69 × 39.
    expect(imageTokens(1920, 1080)).toBe(2691);
  });

  it('applies the high-resolution tier cap (2576 px long edge, 4784 tokens)', () => {
    // The documented 3840×2160 case is downsized to 2576×1449 for 4784 tokens.
    expect(imageTokens(3840, 2160)).toBe(4784);
  });

  it('rejects impossible dimensions', () => {
    expect(() => imageTokens(0, 10)).toThrow(RangeError);
    expect(() => imageTokens(10, Number.NaN)).toThrow(RangeError);
  });
});

describe('planImageResize (PLAN §13: 1008 px long edge)', () => {
  it('shrinks to the long edge, keeping the aspect ratio', () => {
    expect(planImageResize(4000, 3000)).toEqual({ width: 1008, height: 756, tokens: 972 });
    expect(planImageResize(3000, 4000)).toEqual({ width: 756, height: 1008, tokens: 972 });
  });

  it('never upscales', () => {
    expect(planImageResize(640, 480)).toEqual({ width: 640, height: 480, tokens: 23 * 18 });
  });

  it('costs 1,296 tokens for a large square image, as the plan states', () => {
    expect(planImageResize(2048, 2048).tokens).toBe(1296);
  });
});

describe('model prices (pricing page, read 2026-10-17)', () => {
  it('pins the three routed models', () => {
    expect(Object.keys(MODELS).sort()).toEqual([
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('switches Haiku 5.5 to the long-prompt tier above 100,000 prompt tokens', () => {
    expect(priceTier('claude-haiku-5-5', 100_000).input).toBe(100_000);
    expect(priceTier('claude-haiku-5-5', 100_001).input).toBe(500_000);
    expect(priceTier('claude-sonnet-5-5', 900_000).input).toBe(2_000_000);
  });
});

describe('costMicroUsd', () => {
  it('reproduces the plan cost model for one alt-text image on Haiku batch', () => {
    // PLAN §13: (1296 + 400) × $0.05 + 60 × $0.25 per million ≈ $0.0001.
    const cost = costMicroUsd('claude-haiku-5-5', 'batch', {
      input: 1696,
      output: 60,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(cost).toBe(100); // 99.8 µ$ rounded up
  });

  it('prices cache writes and reads with the documented multipliers', () => {
    // 100,000 prompt tokens keeps Haiku 5.5 on its lower tier.
    const usage = { input: 0, output: 0, cacheRead: 100_000, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(costMicroUsd('claude-haiku-5-5', 'sync', usage)).toBe(1_000); // $0.01 per MTok
    expect(costMicroUsd('claude-sonnet-5-5', 'sync', usage)).toBe(10_000); // $0.10 per MTok
    expect(costMicroUsd('claude-opus-5-5', 'sync', usage)).toBe(20_000); // $0.20 per MTok
    expect(
      costMicroUsd('claude-sonnet-5-5', 'sync', {
        ...usage,
        cacheRead: 0,
        cacheWrite1h: 1_000_000,
      }),
    ).toBe(4_000_000);
    expect(
      costMicroUsd('claude-sonnet-5-5', 'sync', {
        ...usage,
        cacheRead: 0,
        cacheWrite5m: 1_000_000,
      }),
    ).toBe(2_500_000);
  });

  it('halves every category on the Batch API', () => {
    const usage = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    };
    expect(costMicroUsd('claude-opus-5-5', 'sync', usage)).toBe(24_000_000);
    expect(costMicroUsd('claude-opus-5-5', 'batch', usage)).toBe(12_000_000);
  });

  it('counts cache reads and writes toward the Haiku prompt-length tier', () => {
    const below = { input: 50_000, output: 0, cacheRead: 50_000, cacheWrite5m: 0, cacheWrite1h: 0 };
    const above = { ...below, cacheWrite5m: 1 };
    expect(costMicroUsd('claude-haiku-5-5', 'sync', below)).toBe(5_000 + 500);
    // One more prompt token moves the whole request to the higher prices.
    expect(costMicroUsd('claude-haiku-5-5', 'sync', above)).toBe(25_000 + 2_500 + 1);
  });

  it('never rounds a non-zero cost down to zero', () => {
    const one = { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(costMicroUsd('claude-haiku-5-5', 'batch', one)).toBe(1);
  });

  it('rejects negative or fractional token counts', () => {
    const bad = { input: -1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(() => costMicroUsd('claude-haiku-5-5', 'sync', bad)).toThrow(RangeError);
    expect(() => costMicroUsd('claude-haiku-5-5', 'sync', { ...bad, input: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('estimates for the budget guard', () => {
  it('overestimates English text', () => {
    const text = 'Organic cotton crew-neck t-shirt in navy blue, front view.';
    expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });

  it('counts non-Latin characters heavily', () => {
    expect(estimateTextTokens('紺色のTシャツ')).toBeGreaterThanOrEqual(8);
  });

  it('prices the worst case: every input token as a 1-hour cache write, all output tokens', () => {
    const worst = worstCaseCostMicroUsd('claude-haiku-5-5', 'batch', 1_000, 400);
    // 1000 × $0.20 + 400 × $0.50 per MTok, halved: (200 + 200) / 2 µ$.
    expect(worst).toBe(200);
  });
});
