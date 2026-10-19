/**
 * AI-proposed patches for custom widgets (PLAN §12 "AI-proposed patches"; Pro plan, §20).
 * Opus 5.5 receives the mapped span, the rendered element, the failed rule and its WCAG
 * criterion, and returns find-and-replace edits through structured outputs. This module
 * turns them into `{file, start, end, replacement}` edits (the liquid-patch form) that touch
 * only the mapped span and add nothing dangerous. The engine then re-parses, runs
 * theme-check and verifies the fix on a preview render; survivors are labelled "AI-proposed"
 * and never applied without developer review.
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
import { estimateTextTokens } from '../cost.ts';
import { AiError } from '../errors.ts';
import type { PatchProposalOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { patchViolations } from '../patch-safety.ts';
import { routeFor } from '../routing.ts';
import {
  containsInvisible,
  detectInstructionLikeText,
  encodeDataBlock,
  sanitizeUntrustedText,
  scrubPersonalData,
  untrustedField,
} from '../untrusted.ts';

export interface PatchProposalInput {
  /** The theme file, for example `sections/slideshow.liquid`. */
  readonly file: string;
  /** Offset of the span in the file, from source mapping. */
  readonly spanStart: number;
  /** The exact source of the mapped span. */
  readonly spanText: string;
  /** The failing element's scrubbed HTML excerpt. */
  readonly renderedElement: string;
  readonly ruleId: string;
  /** The WCAG success criterion, for example `4.1.2`. */
  readonly criterion: string;
  /** What the rule checks, from axe-core's own metadata. */
  readonly ruleDescription: string;
}

export interface PatchEdit {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface PatchProposal {
  readonly label: 'AI-proposed';
  readonly edits: readonly PatchEdit[];
  readonly summary: string;
}

export const MAX_SPAN_CHARS = 20_000;
/** Changed characters across all edits; a widget fix is small. */
export const MAX_CHANGED_CHARS = 4000;
const FORMAT_OVERHEAD_TOKENS = 400;

/** Positions of `needle` in `haystack`; two are enough to know it is not unique. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1 && found.length < 2;
    at = haystack.indexOf(needle, at + 1)
  ) {
    found.push(at);
  }
  return found;
}

/** Links or URLs in the reviewer-facing summary, which is rendered as plain text only. */
const SUMMARY_LINK = /\]\(|https?:\/\/|\bwww\.|javascript:|data:/iu;

interface Context {
  readonly input: PatchProposalInput;
}

export function checkPatchProposal(
  out: PatchProposalOutput,
  ctx: Context,
): TaskResult<PatchProposal> {
  const flags = out.instruction_like_text ? ['instruction_like_text_seen'] : [];
  if (out.edits.length === 0) {
    return { status: 'needs_review', reasons: ['no_safe_fix'], flags };
  }
  const reasons = new Set<string>();
  const local: { start: number; end: number; replacement: string }[] = [];
  let changed = 0;
  for (const edit of out.edits) {
    if (edit.find === '') {
      reasons.add('empty_find');
      continue;
    }
    const at = occurrences(ctx.input.spanText, edit.find);
    if (at.length !== 1 || at[0] === undefined) {
      reasons.add('find_not_unique');
      continue;
    }
    if (edit.find === edit.replace) {
      reasons.add('no_op_edit');
    }
    if (containsInvisible(edit.replace)) {
      reasons.add('hidden_characters');
    }
    changed += edit.find.length + edit.replace.length;
    local.push({ start: at[0], end: at[0] + edit.find.length, replacement: edit.replace });
  }
  local.sort((a, b) => a.start - b.start);
  for (let i = 1; i < local.length; i += 1) {
    const previous = local[i - 1];
    const current = local[i];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      reasons.add('overlapping_edits');
    }
  }
  if (changed > MAX_CHANGED_CHARS) {
    reasons.add('too_large');
  }
  if (detectInstructionLikeText(out.summary).length > 0) {
    reasons.add('instruction_like_output');
  }
  if (SUMMARY_LINK.test(out.summary) || containsInvisible(out.summary)) {
    reasons.add('unsafe_summary');
  }
  if (reasons.size === 0) {
    // The decisive check: the whole span before and after, against the allowlist.
    let patched = ctx.input.spanText;
    for (const e of [...local].reverse()) {
      patched = patched.slice(0, e.start) + e.replacement + patched.slice(e.end);
    }
    for (const violation of patchViolations(ctx.input.spanText, patched)) {
      reasons.add(violation);
    }
  }
  if (reasons.size > 0) {
    return { status: 'needs_review', reasons: [...reasons], flags };
  }
  return {
    status: 'draft',
    value: {
      label: 'AI-proposed',
      edits: local.map((e) => ({
        file: ctx.input.file,
        start: ctx.input.spanStart + e.start,
        end: ctx.input.spanStart + e.end,
        replacement: e.replacement,
      })),
      summary: out.summary,
    },
    flags,
  };
}

/**
 * Builds the patch request. Theme source is code, not personal data, but a span that does
 * contain an email address or phone number is refused rather than scrubbed, because
 * scrubbing would shift the offsets the edits are computed from.
 */
export function preparePatchProposal(
  input: PatchProposalInput,
  options: { readonly tenantId: string },
): PreparedCall<PatchProposal> {
  if (input.spanText.length === 0 || input.spanText.length > MAX_SPAN_CHARS) {
    throw new AiError('ai_input_invalid', 'the mapped span is empty or too long');
  }
  if (!Number.isSafeInteger(input.spanStart) || input.spanStart < 0) {
    throw new AiError('ai_input_invalid', 'the span offset is invalid');
  }
  if (
    !/^(?:layout|sections|snippets|blocks|templates)\/[\w./-]+\.liquid$/u.test(input.file) ||
    input.file.includes('..')
  ) {
    throw new AiError('ai_input_invalid', 'the file is not a theme Liquid file');
  }
  if (scrubPersonalData(input.spanText) !== input.spanText) {
    throw new AiError('ai_input_invalid', 'the span contains personal data');
  }
  if (containsInvisible(input.spanText)) {
    throw new AiError('ai_input_invalid', 'the span contains invisible characters');
  }
  const route = routeFor('patch_proposal', { interactive: false });
  const p = prompt('patch-proposal');
  const rule = encodeDataBlock('rule', {
    id: sanitizeUntrustedText(input.ruleId, 64),
    wcag_criterion: sanitizeUntrustedText(input.criterion, 16),
    description: sanitizeUntrustedText(input.ruleDescription, 1000),
  });
  const renderedHtml = untrustedField(input.renderedElement, 2000);
  const element = encodeDataBlock('rendered_element', { html: renderedHtml });
  const source = encodeDataBlock('theme_source', { file: input.file, span: input.spanText });
  const text = `${rule}\n${element}\n${source}`;
  return {
    task: 'patch_proposal',
    route,
    prompt: p,
    params: buildParams(route, p, [{ type: 'text', text }], options.tenantId),
    estimatedInputTokens:
      estimateTextTokens(p.text) + estimateTextTokens(text) + FORMAT_OVERHEAD_TOKENS,
    inputFlags:
      detectInstructionLikeText(`${input.spanText}\n${renderedHtml}`).length > 0
        ? ['suspected_prompt_injection']
        : [],
    accept: (output) => checkPatchProposal(output as PatchProposalOutput, { input }),
  };
}

/** Synchronous variant for tests and tools; the engine runs proposals through batches. */
export function proposePatch(
  deps: AiDeps,
  input: PatchProposalInput,
  context: CallContext,
): Promise<CallOutcome<PatchProposal>> {
  return runCall(deps, preparePatchProposal(input, { tenantId: context.tenantId }), context);
}
