/**
 * Low contrast text (WCAG 1.4.3), the first recipe of PLAN §12: the smallest change of OKLCH
 * lightness that exceeds 4.5:1 (3:1 for large text), hue and chroma kept, with a second,
 * stronger candidate for the merchant to pick (ADR-242).
 *
 * Unlike the markup recipes, this one edits a colour *value*: a theme setting in JSON
 * (`config/settings_data.json`, a JSON template or a section group) or a declaration in CSS (an
 * asset, a `.css.liquid` asset, or a `{% stylesheet %}` or `{% style %}` tag). Its target is
 * therefore a value span, not an element (ADR-243), and it receives the file's text, not an
 * AST. Running it on its own output reports `already-fixed`.
 */
import { contrastCandidates, type ColorCandidate } from '../color/candidates.ts';
import { contrastRatio, parseColor } from '../color/color.ts';
import type { Edit } from '../edits.ts';
import { locateJsonValue } from '../json.ts';
import type { RecipeOutcome, RefusalCode } from './types.ts';

/** A colour value in theme JSON, by RFC 6901 pointer (offsets, when given, must still match). */
export interface JsonValueSpan {
  readonly kind: 'json-value';
  readonly file: string;
  readonly pointer: string;
  readonly start?: number;
  readonly end?: number;
}

/** A declaration in CSS: from the property name to the end of the value, without the `;`. */
export interface CssDeclarationSpan {
  readonly kind: 'css-declaration';
  readonly file: string;
  readonly property: string;
  readonly start: number;
  readonly end: number;
}

export type ColorSpan = JsonValueSpan | CssDeclarationSpan;

export interface ContrastParams {
  /** The colour behind the text, as the scanner measured it (axe-core's `bgColor`). */
  readonly background: string;
  /** The ratio to exceed. Defaults to 3 for `large` text and 4.5 otherwise. */
  readonly minimumRatio?: number;
  readonly large?: boolean;
}

export interface ContrastCandidate extends ColorCandidate {
  /** Replacing the colour value with this candidate's colour. */
  readonly edits: readonly Edit[];
}

export type ContrastOutcome =
  | {
      readonly kind: 'candidates';
      /** The colour in the theme now and its measured ratio. */
      readonly current: { readonly color: string; readonly ratio: number };
      readonly minimumRatio: number;
      /** One or two, best first (`nearest`, then `stronger`). */
      readonly candidates: readonly ContrastCandidate[];
    }
  | { readonly kind: 'already-fixed'; readonly reason: string }
  | { readonly kind: 'refusal'; readonly code: RefusalCode; readonly detail: string };

function refuse(code: RefusalCode, detail: string): ContrastOutcome {
  return { kind: 'refusal', code, detail };
}

interface Located {
  /** The colour text now in the file. */
  readonly text: string;
  /** The span that holds only that text. */
  readonly start: number;
  readonly end: number;
}

function locateInJson(source: string, span: JsonValueSpan): Located | ContrastOutcome {
  const value = locateJsonValue(source, span.pointer);
  if (value === null) {
    return refuse('target-not-found', `${span.pointer} is not a value in ${span.file}`);
  }
  if (
    (span.start !== undefined && span.start !== value.start) ||
    (span.end !== undefined && span.end !== value.end)
  ) {
    return refuse('target-not-found', `${span.pointer} is not where the mapper saw it`);
  }
  if (value.type !== 'string' || typeof value.value !== 'string') {
    return refuse('unsupported-color', `${span.pointer} is not a string`);
  }
  if (value.value.includes('\\') || value.end - value.start !== value.value.length + 2) {
    return refuse('unsupported-color', `${span.pointer} holds an escape sequence`);
  }
  return { text: value.value, start: value.start + 1, end: value.end - 1 };
}

const IMPORTANT = /\s*!\s*important\s*$/iu;

function locateInCss(source: string, span: CssDeclarationSpan): Located | ContrastOutcome {
  if (!(span.start >= 0 && span.start < span.end && span.end <= source.length)) {
    return refuse(
      'target-not-found',
      `[${String(span.start)}, ${String(span.end)}) is outside ${span.file}`,
    );
  }
  const text = source.slice(span.start, span.end);
  const match = /^([-\w]+)(\s*:\s*)([\s\S]*)$/u.exec(text);
  const property = match?.[1];
  const prefix = match?.[2];
  const rest = match?.[3];
  if (property === undefined || prefix === undefined || rest === undefined) {
    return refuse(
      'target-not-found',
      `no declaration at [${String(span.start)}, ${String(span.end)})`,
    );
  }
  if (property.toLowerCase() !== span.property.toLowerCase()) {
    return refuse('target-not-found', `the declaration is ${property}, not ${span.property}`);
  }
  const value = rest.replace(IMPORTANT, '');
  const trimmed = value.trimEnd();
  const start = span.start + property.length + prefix.length;
  return { text: trimmed, start, end: start + trimmed.length };
}

/**
 * The contrast recipe. `source` is the text of `span.file`.
 *
 * Refusals: `invalid-parameter` (bad background or ratio), `target-not-found` (the value is
 * not where the span says), `unsupported-color` (not one opaque literal colour: `var()`,
 * Liquid output, a gradient, a transparent colour), `contrast-unreachable` (no lightness gets
 * past the ratio on this background).
 */
export const contrast = {
  id: 'contrast',
  wcag: ['1.4.3'],
  run(source: string, span: ColorSpan, params: ContrastParams): ContrastOutcome {
    const background = parseColor(params.background);
    if (background?.alpha !== 1) {
      return refuse('invalid-parameter', `"${params.background}" is not an opaque colour`);
    }
    const minimumRatio = params.minimumRatio ?? (params.large === true ? 3 : 4.5);
    if (!(minimumRatio > 1 && minimumRatio < 21)) {
      return refuse(
        'invalid-parameter',
        `${String(minimumRatio)} is not a contrast ratio to reach`,
      );
    }
    const located =
      span.kind === 'json-value' ? locateInJson(source, span) : locateInCss(source, span);
    if ('kind' in located) return located;
    const foreground = parseColor(located.text);
    if (foreground === null) {
      return refuse('unsupported-color', `"${located.text}" is not one literal colour`);
    }
    if (foreground.alpha !== 1) {
      return refuse('unsupported-color', `"${located.text}" is not opaque`);
    }
    const ratio = contrastRatio(foreground.rgb, background.rgb);
    if (ratio > minimumRatio) {
      return {
        kind: 'already-fixed',
        reason: `${located.text} on ${params.background} is ${ratio.toFixed(2)}:1, above ${String(minimumRatio)}:1`,
      };
    }
    const found = contrastCandidates({
      foreground,
      background: background.rgb,
      minimumRatio,
    });
    if (found.length === 0) {
      return refuse(
        'contrast-unreachable',
        `no lightness of ${located.text} exceeds ${String(minimumRatio)}:1 on ${params.background}`,
      );
    }
    return {
      kind: 'candidates',
      current: { color: located.text, ratio },
      minimumRatio,
      candidates: found.map((candidate) => ({
        ...candidate,
        edits: [
          { file: span.file, start: located.start, end: located.end, replacement: candidate.color },
        ],
      })),
    };
  },
} as const;

/**
 * The common outcome for one candidate (default: the first, `nearest`), so a caller that does
 * not ask the merchant gets edits like any other recipe. The merchant's choice is a candidate id.
 */
export function chooseCandidate(
  outcome: ContrastOutcome,
  id: ColorCandidate['id'] = 'nearest',
): RecipeOutcome {
  if (outcome.kind === 'already-fixed') return { kind: 'already-fixed', reason: outcome.reason };
  if (outcome.kind === 'refusal') return outcome;
  const chosen = outcome.candidates.find((c) => c.id === id);
  if (chosen === undefined) {
    return { kind: 'refusal', code: 'invalid-parameter', detail: `there is no ${id} candidate` };
  }
  return {
    kind: 'edits',
    edits: chosen.edits,
    translations: [],
    notes: [
      `contrast: ${outcome.current.color} (${outcome.current.ratio.toFixed(2)}:1) to ${chosen.color} (${chosen.ratio.toFixed(2)}:1), ${id}`,
    ],
  };
}
