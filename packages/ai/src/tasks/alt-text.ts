/**
 * Alt text for product media (PLAN §12 fix catalog, §13). Haiku 5.5 drafts from the image and
 * the product title; Sonnet 5.5 takes the images Haiku flags (embedded text, low confidence,
 * or a draft that fails the checks below). A draft is written with `fileUpdate` only after a
 * merchant approves it (ADR-004 keeps theme files out of reach; product media is store data).
 */
import {
  encodeDataBlock,
  detectInstructionLikeText,
  hasHiddenOrBreakingCharacters,
  untrustedField,
} from '../untrusted.ts';
import { estimateTextTokens, imageTokens } from '../cost.ts';
import { AiError } from '../errors.ts';
import { imageBlock, validateImage, type ImageInput } from '../images.ts';
import { introducedClaims } from '../claims.ts';
import { isLanguageTag, languageMatches } from '../language.ts';
import type { AltTextOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { routeFor } from '../routing.ts';
import {
  buildParams,
  runCall,
  type AiCallRecord,
  type AiDeps,
  type CallContext,
  type PreparedCall,
  type TaskResult,
} from '../calls.ts';

/**
 * Exactly what an alt-text call may send (PLAN §13, §19): the image, the product title and
 * type, and the store's primary locale. No customer data, no other product fields.
 */
export interface AltTextInput {
  readonly image: ImageInput;
  readonly productTitle: string;
  readonly productType: string;
  /** The store's primary locale, a BCP 47 tag such as `en` or `pt-BR`. */
  readonly primaryLocale: string;
  /** The merchant's limit; PLAN §13 targets 150 characters. */
  readonly maxCharacters?: number;
}

export interface AltTextDraft {
  readonly alt: string;
  readonly containsText: boolean;
  readonly language: string;
  readonly confidence: number;
}

export const ALT_TEXT_DEFAULT_MAX = 150;
export const ALT_TEXT_MIN_LIMIT = 40;
export const ALT_TEXT_MAX_LIMIT = 300;
/** Below this confidence Haiku's draft goes to Sonnet. */
export const ESCALATION_CONFIDENCE = 0.7;

/** Structured outputs add a system prompt of their own; this covers it in estimates. */
const FORMAT_OVERHEAD_TOKENS = 400;

const OPENERS =
  /^\s*(?:(?:an?|the)\s+)?(?:image|picture|photo|photograph|graphic|illustration|screenshot|imagen|imagem|immagine|bild|foto|afbeelding)\s+(?:of|showing|shows|de|des|du|von|di|van|del|da|do)\b/iu;
/**
 * Characters that could break out of an attribute or a script string if a theme prints the
 * alt text unescaped (`alt="{{ image.alt }}"`, `alt='…'`, or inside JavaScript); the prompt
 * asks for ’ instead of ' (alt-text@2).
 */
const MARKUP = /[<>"'`\\]|\{\{|\{%|\}\}|%\}/u;
const URL_OR_EMAIL = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+|\.(?:com|net|org|shop|store)\b/iu;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function length(text: string): number {
  return [...graphemes.segment(text)].length;
}

function resolvedLimit(input: AltTextInput): number {
  const limit = input.maxCharacters ?? ALT_TEXT_DEFAULT_MAX;
  if (!Number.isInteger(limit) || limit < ALT_TEXT_MIN_LIMIT || limit > ALT_TEXT_MAX_LIMIT) {
    throw new AiError(
      'ai_input_invalid',
      `the alt-text limit must be ${String(ALT_TEXT_MIN_LIMIT)} to ${String(ALT_TEXT_MAX_LIMIT)} characters`,
    );
  }
  return limit;
}

interface CheckContext {
  readonly productTitle: string;
  readonly productType: string;
  readonly primaryLocale: string;
  readonly maxCharacters: number;
}

/**
 * The PLAN §13 alt-text rules applied to a schema-valid draft. Any failure sends the draft to
 * review instead of the merchant's approval queue; nothing is trimmed or repaired.
 */
export function checkAltText(out: AltTextOutput, ctx: CheckContext): TaskResult<AltTextDraft> {
  const reasons: string[] = [];
  const flags: string[] = [];
  const alt = out.alt.trim();
  if (out.instruction_like_text) {
    flags.push('instruction_like_text_seen');
  }
  if (out.decorative) {
    reasons.push('marked_decorative');
  } else if (alt === '') {
    reasons.push('empty');
  }
  if (alt !== '') {
    if (length(alt) > ctx.maxCharacters) reasons.push('too_long');
    if (OPENERS.test(alt)) reasons.push('starts_with_image_of');
    if (MARKUP.test(alt)) reasons.push('markup_characters');
    if (hasHiddenOrBreakingCharacters(out.alt)) reasons.push('hidden_characters');
    if (URL_OR_EMAIL.test(alt)) reasons.push('url_or_email');
    if (detectInstructionLikeText(alt).length > 0) reasons.push('instruction_like_output');
    if (introducedClaims(alt, [ctx.productTitle, ctx.productType]).length > 0) {
      reasons.push('banned_claim');
    }
    if (!isLanguageTag(out.language) || !languageMatches(alt, out.language, ctx.primaryLocale)) {
      reasons.push('language_mismatch');
    }
  }
  if (reasons.length > 0) {
    return { status: 'needs_review', reasons, flags };
  }
  return {
    status: 'draft',
    value: {
      alt,
      containsText: out.contains_text,
      language: out.language,
      confidence: out.confidence,
    },
    flags,
  };
}

/** Builds the call for one image; the same call serves the synchronous and the batch path. */
export function prepareAltText(
  input: AltTextInput,
  options: {
    readonly tenantId: string;
    readonly escalated?: boolean;
    readonly interactive?: boolean;
  },
): PreparedCall<AltTextDraft> {
  validateImage(input.image);
  const maxCharacters = resolvedLimit(input);
  if (!isLanguageTag(input.primaryLocale)) {
    throw new AiError('ai_input_invalid', 'the primary locale is not a BCP 47 language tag');
  }
  const productTitle = untrustedField(input.productTitle, 255);
  const productType = untrustedField(input.productType, 255);
  const route = routeFor(options.escalated === true ? 'alt_text_escalated' : 'alt_text', {
    interactive: options.interactive === true,
  });
  const p = prompt('alt-text');
  const data = encodeDataBlock('merchant_data', {
    product_title: productTitle,
    product_type: productType,
    primary_locale: input.primaryLocale,
    max_characters: maxCharacters,
  });
  const inputFlags =
    detectInstructionLikeText(`${productTitle}\n${productType}`).length > 0
      ? ['suspected_prompt_injection']
      : [];
  const ctx: CheckContext = {
    productTitle,
    productType,
    primaryLocale: input.primaryLocale,
    maxCharacters,
  };
  return {
    task: route.task,
    route,
    prompt: p,
    params: buildParams(
      route,
      p,
      [imageBlock(input.image), { type: 'text', text: data }],
      options.tenantId,
    ),
    estimatedInputTokens:
      imageTokens(input.image.width, input.image.height, route.model) +
      estimateTextTokens(p.text) +
      estimateTextTokens(data) +
      FORMAT_OVERHEAD_TOKENS,
    inputFlags,
    accept: (output) => checkAltText(output as AltTextOutput, ctx),
  };
}

/**
 * Whether a first-pass Haiku result goes to Sonnet (PLAN §13): embedded text such as a size
 * chart, low confidence, or a draft the checks sent to review for anything but being
 * decorative.
 */
export function needsEscalation(result: TaskResult<AltTextDraft>): boolean {
  if (result.status === 'needs_review') {
    return result.reasons.some((r) => r !== 'marked_decorative');
  }
  return result.value.containsText || result.value.confidence < ESCALATION_CONFIDENCE;
}

export interface AltTextOutcome {
  readonly result: TaskResult<AltTextDraft>;
  readonly escalated: boolean;
  readonly promptVersion: string;
  readonly model: string;
  readonly records: readonly AiCallRecord[];
}

/** Drafts alt text for one image synchronously, escalating once when Haiku flags it. */
export async function generateAltText(
  deps: AiDeps,
  input: AltTextInput,
  context: CallContext & { readonly interactive?: boolean },
): Promise<AltTextOutcome> {
  const options = { tenantId: context.tenantId, interactive: context.interactive ?? true };
  const first = await runCall(deps, prepareAltText(input, options), context);
  if (!needsEscalation(first.result)) {
    return {
      result: first.result,
      escalated: false,
      promptVersion: first.record.promptVersion,
      model: first.record.model,
      records: [first.record],
    };
  }
  const second = await runCall(
    deps,
    prepareAltText(input, { ...options, escalated: true }),
    context,
  );
  return {
    result: second.result,
    escalated: true,
    promptVersion: second.record.promptVersion,
    model: second.record.model,
    records: [first.record, second.record],
  };
}
