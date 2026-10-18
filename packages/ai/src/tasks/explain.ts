/**
 * Plain-language explanations per rule (PLAN §13 routing table): drafted once per rule and
 * locale by Haiku 5.5, stored, reused for every tenant, and edited by a human before release.
 * Because the result becomes UI copy, any banned claim (PLAN §3) rejects the draft outright.
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
import { bannedClaims } from '../claims.ts';
import { estimateTextTokens } from '../cost.ts';
import { AiError } from '../errors.ts';
import { isLanguageTag, languageMatches } from '../language.ts';
import type { ExplainOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { routeFor } from '../routing.ts';
import { detectInstructionLikeText, encodeDataBlock, sanitizeUntrustedText } from '../untrusted.ts';

export interface ExplainInput {
  /** The axe-core or Rampsmith rule id, for example `image-alt`. */
  readonly ruleId: string;
  /** WCAG success criteria, for example `['1.1.1']`. */
  readonly criteria: readonly string[];
  /** The rule's technical description, from axe-core's metadata. */
  readonly description: string;
  readonly locale: string;
}

export interface Explanation {
  readonly ruleId: string;
  readonly locale: string;
  readonly title: string;
  readonly summary: string;
  readonly whoIsAffected: string;
  readonly howToFix: string;
}

const FORMAT_OVERHEAD_TOKENS = 400;

export function checkExplanation(out: ExplainOutput, input: ExplainInput): TaskResult<Explanation> {
  const fields = [out.title, out.summary, out.who_is_affected, out.how_to_fix];
  const all = fields.join('\n');
  const reasons: string[] = [];
  if (fields.some((f) => f.trim() === '')) reasons.push('empty_field');
  if (bannedClaims(all).length > 0) reasons.push('banned_claim');
  if (/[<>]|\{\{|\{%/u.test(all)) reasons.push('markup_characters');
  if (detectInstructionLikeText(all).length > 0) reasons.push('instruction_like_output');
  if (!isLanguageTag(out.language) || !languageMatches(all, out.language, input.locale)) {
    reasons.push('language_mismatch');
  }
  if (reasons.length > 0) {
    return { status: 'needs_review', reasons, flags: [] };
  }
  return {
    status: 'draft',
    value: {
      ruleId: input.ruleId,
      locale: input.locale,
      title: out.title.trim(),
      summary: out.summary.trim(),
      whoIsAffected: out.who_is_affected.trim(),
      howToFix: out.how_to_fix.trim(),
    },
    flags: ['human_edit_required'],
  };
}

export function prepareExplanation(
  input: ExplainInput,
  options: { readonly tenantId: string },
): PreparedCall<Explanation> {
  if (!/^[a-z0-9-]{1,64}$/u.test(input.ruleId)) {
    throw new AiError('ai_input_invalid', 'the rule id is not a rule id');
  }
  if (!isLanguageTag(input.locale)) {
    throw new AiError('ai_input_invalid', 'the locale is not a BCP 47 language tag');
  }
  if (input.criteria.some((c) => !/^\d\.\d{1,2}\.\d{1,2}$/u.test(c))) {
    throw new AiError('ai_input_invalid', 'criteria must be WCAG success criterion numbers');
  }
  const route = routeFor('explain', { interactive: false });
  const p = prompt('explain');
  const data = encodeDataBlock('rule', {
    id: input.ruleId,
    wcag_success_criteria: input.criteria,
    description: sanitizeUntrustedText(input.description, 1000),
    locale: input.locale,
  });
  return {
    task: 'explain',
    route,
    prompt: p,
    params: buildParams(route, p, [{ type: 'text', text: data }], options.tenantId),
    estimatedInputTokens:
      estimateTextTokens(p.text) + estimateTextTokens(data) + FORMAT_OVERHEAD_TOKENS,
    inputFlags: [],
    accept: (output) => checkExplanation(output as ExplainOutput, input),
  };
}

/**
 * Explanations are platform content, not tenant work: the engine runs them under its own
 * operator tenant id and budget.
 */
export function explainRule(
  deps: AiDeps,
  input: ExplainInput,
  context: CallContext,
): Promise<CallOutcome<Explanation>> {
  return runCall(deps, prepareExplanation(input, { tenantId: context.tenantId }), context);
}
