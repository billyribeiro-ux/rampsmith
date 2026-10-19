/**
 * Cost accounting against the PLAN §13 cost model, from documented prices (ADR-212, ADR-214).
 * Money is integer micro-dollars (PLAN §8, §9 `ai_calls`), always rounded up so the ledger
 * never under-counts.
 */
import { BATCH_DISCOUNT_DIVISOR, MODELS, priceTier, type ModelId } from './models.ts';

export type CallMode = 'sync' | 'batch';

/** Token counts as the Messages API reports them in `usage`. */
export interface TokenUsage {
  /** Uncached input after the last cache breakpoint (`input_tokens`). */
  readonly input: number;
  /** All output, thinking included (`output_tokens`). */
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** Each patch is 28 × 28 pixels (https://platform.claude.com/docs/en/build-with-claude/vision). */
const PATCH = 28;

/** PLAN §13: `sharp` resizes every product image to this long edge before a vision call. */
export const ALT_TEXT_LONG_EDGE = 1008;

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 8000) {
    throw new RangeError(`${name} must be an integer from 1 to 8000 pixels`);
  }
}

function patches(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

/**
 * Visual tokens for an image as the high-resolution tier (all routed models) processes it:
 * images over 2576 px on the long edge or over 4784 tokens are first downscaled, keeping the
 * aspect ratio, to the largest size inside both limits.
 */
export function imageTokens(
  width: number,
  height: number,
  model: ModelId = 'claude-haiku-5-5',
): number {
  assertDimension('width', width);
  assertDimension('height', height);
  const { maxLongEdge, maxTokens } = MODELS[model].image;
  const longEdge = Math.max(width, height);
  let scale = Math.min(1, maxLongEdge / longEdge);
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  while (patches(w, h) > maxTokens) {
    scale *= 0.99;
    w = Math.max(1, Math.round(width * scale));
    h = Math.max(1, Math.round(height * scale));
  }
  return patches(w, h);
}

export interface ResizePlan {
  readonly width: number;
  readonly height: number;
  readonly tokens: number;
}

/**
 * The size the engine resizes an image to before an alt-text call (never upscaling), and the
 * visual tokens it will cost.
 */
export function planImageResize(
  width: number,
  height: number,
  longEdge: number = ALT_TEXT_LONG_EDGE,
): ResizePlan {
  assertDimension('width', width);
  assertDimension('height', height);
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { width: w, height: h, tokens: imageTokens(w, h) };
}

function assertTokens(usage: TokenUsage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`usage.${name} must be a non-negative integer`);
    }
  }
}

/** Prompt length as the pricing page defines it: every input token, cached or not. */
export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
}

/**
 * Cost of one request in micro-dollars, rounded up. Tokens × (µ$ per million tokens) is in
 * pico-dollars, which stays an exact integer far beyond any single request.
 */
export function costMicroUsd(model: ModelId, mode: CallMode, usage: TokenUsage): number {
  assertTokens(usage);
  const tier = priceTier(model, promptTokens(usage));
  const pico =
    usage.input * tier.input +
    usage.output * tier.output +
    usage.cacheRead * tier.cacheRead +
    usage.cacheWrite5m * tier.cacheWrite5m +
    usage.cacheWrite1h * tier.cacheWrite1h;
  const divisor = 1_000_000 * (mode === 'batch' ? BATCH_DISCOUNT_DIVISOR : 1);
  return Math.ceil(pico / divisor);
}

/**
 * A deliberate overestimate of the tokens in `text`, for budget reservations only. Claude's
 * tokenizer for 4.7 and later models produces about 30% more tokens than earlier ones, so
 * Latin text is counted at one token per three characters and every other character as 1.5.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil((ascii / 3 + other * 1.5) * 1.1);
}

/**
 * The most a request can cost: every input token billed as a 1-hour cache write (the dearest
 * input category) and every allowed output token produced. The budget guard reserves this
 * before the call is made (PLAN §13).
 */
export function worstCaseCostMicroUsd(
  model: ModelId,
  mode: CallMode,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  return costMicroUsd(model, mode, {
    input: 0,
    output: maxOutputTokens,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: inputTokens,
  });
}
