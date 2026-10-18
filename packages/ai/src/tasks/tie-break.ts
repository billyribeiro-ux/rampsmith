/**
 * Source-mapping tie-breaks (PLAN §12 "Mapping a rendered element to its source", step 4):
 * several candidates matched the rendered element, and Sonnet 5.5 chooses one, citing the
 * attribute that distinguishes it. The citation is checked against the HTML and the source;
 * an unproven, uncertain or missing choice is `needs_review`.
 */
import { parseFragment } from 'parse5';
import {
  buildParams,
  runCall,
  type AiDeps,
  type CallContext,
  type CallOutcome,
  type PreparedCall,
  type TaskResult,
} from '../calls.ts';
import { estimateTextTokens } from '../cost.ts';
import { AiError } from '../errors.ts';
import type { TieBreakOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { routeFor } from '../routing.ts';
import {
  detectInstructionLikeText,
  encodeDataBlock,
  sanitizeUntrustedText,
  scrubPersonalData,
} from '../untrusted.ts';

export interface TieBreakCandidate {
  /** `^[A-Za-z0-9_-]{1,64}$`. */
  readonly id: string;
  readonly file: string;
  /** The candidate's Liquid and HTML source excerpt. */
  readonly snippet: string;
}

export interface TieBreakInput {
  /** The rendered element's HTML excerpt, already scrubbed (PLAN §9 `html_excerpt`). */
  readonly renderedElement: string;
  readonly ruleId: string;
  readonly candidates: readonly TieBreakCandidate[];
}

export interface TieBreakChoice {
  readonly candidateId: string;
  readonly file: string;
  readonly attribute: { readonly name: string; readonly value: string };
  readonly confidence: number;
}

/** PLAN §12: mapped only above 0.9 confidence. */
export const TIE_BREAK_MIN_CONFIDENCE = 0.9;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/u;
const FORMAT_OVERHEAD_TOKENS = 400;

function renderedAttributes(html: string): Map<string, string> {
  const fragment = parseFragment(html);
  const first = fragment.childNodes.find((n) => 'tagName' in n);
  const attrs = first !== undefined && 'attrs' in first ? first.attrs : [];
  return new Map(attrs.map((a) => [a.name.toLowerCase(), a.value]));
}

function mentions(snippet: string, name: string, value: string): boolean {
  const attribute = new RegExp(`(?:^|[\\s"'<])${name.replace(/[.:]/gu, '\\$&')}\\s*=`, 'iu');
  return attribute.test(snippet) && snippet.includes(value);
}

interface Context {
  readonly input: TieBreakInput;
}

export function checkTieBreak(out: TieBreakOutput, ctx: Context): TaskResult<TieBreakChoice> {
  const flags = out.instruction_like_text ? ['instruction_like_text_seen'] : [];
  if (out.candidate_id === null) {
    return { status: 'needs_review', reasons: ['no_choice'], flags };
  }
  const chosen = ctx.input.candidates.find((c) => c.id === out.candidate_id);
  if (chosen === undefined) {
    return { status: 'needs_review', reasons: ['unknown_candidate'], flags };
  }
  const reasons: string[] = [];
  if (out.confidence < TIE_BREAK_MIN_CONFIDENCE) {
    reasons.push('low_confidence');
  }
  const { name, value } = out.distinguishing_attribute;
  const rendered = renderedAttributes(ctx.input.renderedElement).get(name.toLowerCase());
  if (
    !ATTRIBUTE_NAME.test(name) ||
    value.trim() === '' ||
    rendered === undefined ||
    !rendered.includes(value) ||
    !mentions(chosen.snippet, name, value) ||
    ctx.input.candidates.some((c) => c.id !== chosen.id && mentions(c.snippet, name, value))
  ) {
    reasons.push('attribute_not_distinguishing');
  }
  if (reasons.length > 0) {
    return { status: 'needs_review', reasons, flags };
  }
  return {
    status: 'draft',
    value: {
      candidateId: chosen.id,
      file: chosen.file,
      attribute: { name, value },
      confidence: out.confidence,
    },
    flags,
  };
}

export function prepareTieBreak(
  input: TieBreakInput,
  options: { readonly tenantId: string },
): PreparedCall<TieBreakChoice> {
  if (input.candidates.length < 2 || input.candidates.length > 10) {
    throw new AiError('ai_input_invalid', 'a tie-break needs 2 to 10 candidates');
  }
  if (
    new Set(input.candidates.map((c) => c.id)).size !== input.candidates.length ||
    input.candidates.some((c) => !ID.test(c.id))
  ) {
    throw new AiError('ai_input_invalid', 'candidate ids must be unique and safe');
  }
  if (!/^[a-z0-9-]{1,64}$/u.test(input.ruleId)) {
    throw new AiError('ai_input_invalid', 'the rule id is not an axe rule id');
  }
  const element = scrubPersonalData(sanitizeUntrustedText(input.renderedElement, 2000));
  const candidates = input.candidates.map((c) => ({
    id: c.id,
    file: sanitizeUntrustedText(c.file, 200),
    source: scrubPersonalData(sanitizeUntrustedText(c.snippet, 4000)),
  }));
  const route = routeFor('tie_break', { interactive: false });
  const p = prompt('tie-break');
  const rendered = encodeDataBlock('rendered_element', {
    html: element,
    failed_rule: input.ruleId,
  });
  const listed = encodeDataBlock('candidates', candidates);
  const all = [input.renderedElement, ...input.candidates.map((c) => c.snippet)].join('\n');
  return {
    task: 'tie_break',
    route,
    prompt: p,
    params: buildParams(
      route,
      p,
      [{ type: 'text', text: `${rendered}\n${listed}` }],
      options.tenantId,
    ),
    estimatedInputTokens:
      estimateTextTokens(p.text) +
      estimateTextTokens(rendered) +
      estimateTextTokens(listed) +
      FORMAT_OVERHEAD_TOKENS,
    inputFlags: detectInstructionLikeText(all).length > 0 ? ['suspected_prompt_injection'] : [],
    // The check runs on what the model saw, so a citation of scrubbed text cannot pass.
    accept: (output) =>
      checkTieBreak(output as TieBreakOutput, {
        input: {
          renderedElement: element,
          ruleId: input.ruleId,
          candidates: candidates.map((c) => ({ id: c.id, file: c.file, snippet: c.source })),
        },
      }),
  };
}

export function breakTie(
  deps: AiDeps,
  input: TieBreakInput,
  context: CallContext,
): Promise<CallOutcome<TieBreakChoice>> {
  return runCall(deps, prepareTieBreak(input, { tenantId: context.tenantId }), context);
}
