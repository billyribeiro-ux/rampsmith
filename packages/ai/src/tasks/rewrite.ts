/**
 * Description and page rewrites for skipped headings and vague link text (PLAN §12, §13;
 * WCAG 1.3.1 and 2.4.4). Sonnet 5.5 proposes heading levels and link text; the change is
 * applied to the merchant's own HTML as span edits and written through the Admin API only
 * after human review ("Human review always").
 */
import {
  buildParams,
  runCall,
  type AiDeps,
  type CallContext,
  type CallOutcome,
  type PreparedCall,
  type TaskResult,
} from '../calls.ts';
import { introducedClaims } from '../claims.ts';
import { estimateTextTokens } from '../cost.ts';
import { AiError } from '../errors.ts';
import {
  analyzeDescription,
  applyRewrite,
  isVagueLinkText,
  validHeadingOutline,
  type DescriptionAnalysis,
} from '../html.ts';
import { isLanguageTag, languageMatches } from '../language.ts';
import type { RewriteOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { routeFor } from '../routing.ts';
import {
  detectInstructionLikeText,
  encodeDataBlock,
  sanitizeUntrustedText,
  scrubPersonalData,
  stripQueryAndFragment,
} from '../untrusted.ts';

export interface RewriteInput {
  /** `descriptionHtml` of a product, or the `body` of a page or article. */
  readonly html: string;
  /** The product, page or article title, rendered as the page's level 1 heading. */
  readonly pageTitle: string;
  readonly primaryLocale: string;
  /** The level the first heading must use; 2 under a level 1 page title. */
  readonly baseLevel?: number;
}

export interface RewriteDraft {
  /** A data fix's diff (PLAN §9 `fixes.diff`): the field's value before and after. */
  readonly before: string;
  readonly after: string;
  readonly headings: readonly {
    readonly index: number;
    readonly from: number;
    readonly to: number;
  }[];
  readonly links: readonly { readonly index: number; readonly from: string; readonly to: string }[];
}

/** Larger fields go to review untouched; a description this long is not a quick fix. */
export const MAX_REWRITE_HTML = 100_000;
const MAX_HEADINGS = 100;
const MAX_LINKS = 200;
const FORMAT_OVERHEAD_TOKENS = 400;

const MARKUP = /[<>"`]|\{\{|\{%/u;
const URL_LIKE = /https?:\/\/|\bwww\./iu;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function length(text: string): number {
  return [...graphemes.segment(text)].length;
}

function clean(text: string, max: number): string {
  return scrubPersonalData(sanitizeUntrustedText(text, max));
}

interface Context {
  readonly html: string;
  readonly analysis: DescriptionAnalysis;
  readonly baseLevel: number;
  readonly primaryLocale: string;
  readonly sources: readonly string[];
}

/** Checks the proposal, applies it to the original HTML and proves nothing else changed. */
export function checkRewrite(out: RewriteOutput, ctx: Context): TaskResult<RewriteDraft> {
  const reasons: string[] = [];
  const flags = out.instruction_like_text ? ['instruction_like_text_seen'] : [];
  const { analysis } = ctx;

  const levels = new Map<number, number>();
  for (const h of out.headings) {
    if (h.index >= analysis.headings.length || levels.has(h.index)) {
      reasons.push('unknown_heading');
    }
    levels.set(h.index, h.level);
  }
  const ordered = analysis.headings.map((h) => levels.get(h.index));
  if (ordered.some((l) => l === undefined)) {
    reasons.push('incomplete_headings');
  } else if (!validHeadingOutline(ordered as number[], ctx.baseLevel)) {
    reasons.push('invalid_outline');
  }

  const texts = new Map<number, string>();
  for (const l of out.links) {
    if (!analysis.linkIssues.includes(l.index) || texts.has(l.index)) {
      reasons.push('unrequested_link');
    }
    texts.set(l.index, l.text.trim());
  }
  if (analysis.linkIssues.some((i) => !texts.has(i))) {
    reasons.push('incomplete_links');
  }
  for (const text of texts.values()) {
    if (length(text) < 2 || length(text) > 100) reasons.push('link_text_length');
    if (isVagueLinkText(text)) reasons.push('vague_link_text');
    if (MARKUP.test(text) || URL_LIKE.test(text)) reasons.push('markup_or_url');
    if (detectInstructionLikeText(text).length > 0) reasons.push('instruction_like_output');
    if (introducedClaims(text, ctx.sources).length > 0) reasons.push('banned_claim');
    if (!languageMatches(text, ctx.primaryLocale, ctx.primaryLocale))
      reasons.push('language_mismatch');
  }
  if (reasons.length > 0) {
    return { status: 'needs_review', reasons: [...new Set(reasons)], flags };
  }

  const headingChanges = new Map(
    [...levels].filter(([i, level]) => analysis.headings[i]?.level !== level),
  );
  const linkChanges = new Map([...texts].filter(([i, text]) => analysis.links[i]?.name !== text));
  if (headingChanges.size === 0 && linkChanges.size === 0) {
    return { status: 'needs_review', reasons: ['no_change'], flags };
  }
  let after: string;
  try {
    after = applyRewrite(ctx.html, analysis, { headings: headingChanges, links: linkChanges });
  } catch {
    return { status: 'needs_review', reasons: ['unsafe_edit'], flags };
  }
  return {
    status: 'draft',
    value: {
      before: ctx.html,
      after,
      headings: [...headingChanges].map(([index, to]) => ({
        index,
        from: analysis.headings[index]?.level ?? to,
        to,
      })),
      links: [...linkChanges].map(([index, to]) => ({
        index,
        from: analysis.links[index]?.name ?? '',
        to,
      })),
    },
    flags,
  };
}

/**
 * Builds the rewrite call, or returns `null` when the HTML has no heading or link issue.
 * Only the titles of headings, flagged links, their targets without query strings and the
 * text around them are sent; never the whole field.
 */
export function prepareRewrite(
  input: RewriteInput,
  options: { readonly tenantId: string; readonly interactive?: boolean },
): PreparedCall<RewriteDraft> | null {
  if (input.html.length > MAX_REWRITE_HTML) {
    throw new AiError('ai_input_invalid', 'the HTML is too long for an automated rewrite');
  }
  if (!isLanguageTag(input.primaryLocale)) {
    throw new AiError('ai_input_invalid', 'the primary locale is not a BCP 47 language tag');
  }
  const baseLevel = input.baseLevel ?? 2;
  if (!Number.isInteger(baseLevel) || baseLevel < 1 || baseLevel > 6) {
    throw new AiError('ai_input_invalid', 'the base heading level must be 1 to 6');
  }
  const analysis = analyzeDescription(input.html, baseLevel);
  if (analysis.headingIssues.length === 0 && analysis.linkIssues.length === 0) {
    return null;
  }
  if (analysis.headings.length > MAX_HEADINGS || analysis.links.length > MAX_LINKS) {
    throw new AiError('ai_input_invalid', 'the HTML has too many headings or links to rewrite');
  }
  const route = routeFor('rewrite', { interactive: options.interactive === true });
  const p = prompt('rewrite');
  const data = encodeDataBlock('merchant_data', {
    page_title: clean(input.pageTitle, 255),
    primary_locale: input.primaryLocale,
    base_level: baseLevel,
    headings: analysis.headings.map((h) => ({
      index: h.index,
      level: h.level,
      text: clean(h.text, 200),
    })),
    links: analysis.linkIssues.map((i) => {
      const link = analysis.links[i];
      return {
        index: i,
        current_text: clean(link?.name ?? '', 200),
        target: stripQueryAndFragment(link?.href ?? ''),
        surrounding_text: clean(link?.context ?? '', 300),
      };
    }),
  });
  const visible = [
    input.pageTitle,
    ...analysis.headings.map((h) => h.text),
    ...analysis.links.map((l) => `${l.name} ${l.context}`),
  ];
  const ctx: Context = {
    html: input.html,
    analysis,
    baseLevel,
    primaryLocale: input.primaryLocale,
    sources: visible,
  };
  return {
    task: 'rewrite',
    route,
    prompt: p,
    params: buildParams(route, p, [{ type: 'text', text: data }], options.tenantId),
    estimatedInputTokens:
      estimateTextTokens(p.text) + estimateTextTokens(data) + FORMAT_OVERHEAD_TOKENS,
    inputFlags:
      detectInstructionLikeText(visible.join('\n')).length > 0
        ? ['suspected_prompt_injection']
        : [],
    accept: (output) => checkRewrite(output as RewriteOutput, ctx),
  };
}

/** Runs a synchronous rewrite; `null` when there is nothing to fix. */
export async function generateRewrite(
  deps: AiDeps,
  input: RewriteInput,
  context: CallContext & { readonly interactive?: boolean },
): Promise<CallOutcome<RewriteDraft> | null> {
  const call = prepareRewrite(input, {
    tenantId: context.tenantId,
    interactive: context.interactive ?? true,
  });
  return call === null ? null : runCall(deps, call, context);
}
