/**
 * From a mapped finding to the edits of its recipe (ADR-248): which recipe fixes which rule,
 * which parameters the engine supplies itself, and which the caller must bring.
 *
 * The engine supplies what is mechanical: the span from the mapper, and for contrast the
 * background colour and text size the scanner measured. The caller brings what needs judgement:
 * the label text and translation key of a link, button or field, an image's decorative reason.
 * A rule without a deterministic recipe returns `null`; a recipe that cannot fix this instance
 * returns its typed refusal.
 */
import type { CandidateId } from './color/candidates.ts';
import { contrastRatio, isLargeText, parseColor } from './color/color.ts';
import type { MappedSpan } from './map/types.ts';
import { parseThemeFile, type ParsedFile } from './parse.ts';
import {
  chooseCandidate,
  contrast,
  type ColorSpan,
  type ContrastCandidate,
  type ContrastOutcome,
} from './recipes/contrast.ts';
import { documentLanguage } from './recipes/document-language.ts';
import { emptyButton } from './recipes/empty-button.ts';
import { emptyLink } from './recipes/empty-link.ts';
import { formLabel } from './recipes/form-label.ts';
import { imageAlt } from './recipes/image-alt.ts';
import { skipLink } from './recipes/skip-link.ts';
import { refuse, type RecipeOutcome, type RecipeTarget } from './recipes/types.ts';
import type { TranslationRequirement } from './translations.ts';

/** What the caller brings: judgement the engine cannot take from the theme or the scan. */
export interface FixParams {
  /** The translation key and English text of the accessible name. */
  readonly label?: TranslationRequirement;
  /** The theme's visually hidden class; the recipes default to `visually-hidden`. */
  readonly visuallyHiddenClass?: string;
  /** The id for a form control that has none (may contain Liquid output). */
  readonly id?: string;
  /** Mark an image decorative, with the reason recorded. */
  readonly decorative?: { readonly reason: string };
}

/** What the scan measured for a `color-contrast` finding. */
export interface ContrastEvidence {
  /** The colour behind the text (axe-core's `bgColor`). */
  readonly background: string;
  /** Computed font size in CSS pixels, and whether the weight is 700 or more. */
  readonly fontSizePx: number;
  readonly bold: boolean;
}

export interface FixRequest {
  /** The rule that fired (an axe-core rule id). */
  readonly rule: string;
  /** Where the mapper put the fix. */
  readonly span: MappedSpan;
  /** Theme files by theme-relative path. */
  readonly files: ReadonlyMap<string, string>;
  readonly params?: FixParams;
  /**
   * For `color-contrast`: what the scan measured. A finding with several nodes may sit on
   * several backgrounds; give one evidence per distinct measure and the planner picks the
   * smallest change that clears all of them (or refuses).
   */
  readonly contrast?: ContrastEvidence | readonly ContrastEvidence[];
  /** For `color-contrast`: which candidate to apply; defaults to `nearest`. */
  readonly candidate?: CandidateId;
}

const ELEMENT_RULES: ReadonlySet<string> = new Set([
  'html-has-lang',
  'html-lang-valid',
  'image-alt',
  'label',
  'select-name',
  'link-name',
  'button-name',
  'bypass',
]);

/** True when a rule has a deterministic recipe. */
export function hasRecipe(rule: string): boolean {
  return rule === 'color-contrast' || ELEMENT_RULES.has(rule);
}

function runElementRecipe(
  rule: string,
  file: ParsedFile,
  target: RecipeTarget,
  params: FixParams,
): RecipeOutcome | null {
  const hidden =
    params.visuallyHiddenClass === undefined
      ? {}
      : { visuallyHiddenClass: params.visuallyHiddenClass };
  const { label } = params;
  const needLabel = (): RecipeOutcome =>
    refuse('invalid-parameter', `${rule} needs a label (a translation key and its text)`);
  switch (rule) {
    case 'html-has-lang':
    case 'html-lang-valid':
      return documentLanguage.run(file, target, {});
    case 'image-alt':
      return imageAlt.run(
        file,
        target,
        params.decorative === undefined ? {} : { decorative: params.decorative },
      );
    case 'label':
    case 'select-name':
      return label === undefined
        ? needLabel()
        : formLabel.run(file, target, {
            label,
            ...hidden,
            ...(params.id === undefined ? {} : { id: params.id }),
          });
    case 'link-name':
      return label === undefined ? needLabel() : emptyLink.run(file, target, { label, ...hidden });
    case 'button-name':
      return label === undefined ? needLabel() : emptyButton.run(file, target, { label });
    case 'bypass':
      return skipLink.run(file, target, label === undefined ? {} : { label });
    default:
      return null;
  }
}

function evidenceList(
  evidence: ContrastEvidence | readonly ContrastEvidence[] | undefined,
): readonly ContrastEvidence[] {
  if (evidence === undefined) return [];
  return 'background' in evidence ? [evidence] : evidence;
}

function isLarge(evidence: ContrastEvidence): boolean {
  return isLargeText(evidence.fontSizePx, evidence.bold ? 700 : 400);
}

/**
 * The candidate that clears every background: the smallest change of lightness among the
 * candidates each background produced that exceeds the ratio on all of them. `stronger` asks for
 * the enhanced level of WCAG 1.4.6 (7:1, or 4.5:1 for large text) on all of them.
 */
function candidateForAll(
  outcomes: readonly ContrastOutcome[],
  evidence: readonly ContrastEvidence[],
  id: CandidateId,
): RecipeOutcome {
  const refusal = outcomes.find((o) => o.kind === 'refusal');
  if (refusal?.kind === 'refusal') return refusal;
  const pool: ContrastCandidate[] = outcomes.flatMap((o) =>
    o.kind === 'candidates' ? o.candidates : [],
  );
  const first = outcomes[0];
  if (pool.length === 0) {
    return first?.kind === 'already-fixed'
      ? { kind: 'already-fixed', reason: first.reason }
      : refuse('contrast-unreachable', 'no candidate colour was found');
  }
  const wanted = evidence.map((e) => {
    const background = parseColor(e.background);
    const large = isLarge(e);
    return { rgb: background?.rgb, ratio: id === 'stronger' ? (large ? 4.5 : 7) : large ? 3 : 4.5 };
  });
  const chosen = pool
    .filter((c) =>
      wanted.every((w) => w.rgb !== undefined && contrastRatio(c.rgb, w.rgb) > w.ratio),
    )
    .sort((a, b) => Math.abs(a.deltaL) - Math.abs(b.deltaL))[0];
  if (chosen === undefined) {
    return refuse(
      'contrast-unreachable',
      `no ${id} colour of the candidates exceeds the ratio on all ${String(evidence.length)} backgrounds`,
    );
  }
  return {
    kind: 'edits',
    edits: chosen.edits,
    translations: [],
    notes: [`contrast: ${chosen.color} clears ${String(evidence.length)} backgrounds, ${id}`],
  };
}

function planContrast(request: FixRequest): RecipeOutcome {
  const { span, files } = request;
  if (span.kind !== 'json-value' && span.kind !== 'css-declaration') {
    return refuse(
      'wrong-element',
      `color-contrast is fixed on a colour value, not on a ${span.kind}`,
    );
  }
  const distinct = new Map(
    evidenceList(request.contrast).map((e) => [`${e.background}|${String(isLarge(e))}`, e]),
  );
  const evidence = [...distinct.values()];
  if (evidence.length === 0) {
    return refuse(
      'invalid-parameter',
      'color-contrast needs the measured background and text size',
    );
  }
  const source = files.get(span.file);
  if (source === undefined) return refuse('wrong-file', `${span.file} is not in the theme`);
  const colorSpan: ColorSpan = span;
  const outcomes = evidence.map((e) =>
    contrast.run(source, colorSpan, { background: e.background, large: isLarge(e) }),
  );
  const id = request.candidate ?? 'nearest';
  const [only] = outcomes;
  return outcomes.length === 1 && only !== undefined
    ? chooseCandidate(only, id)
    : candidateForAll(outcomes, evidence, id);
}

/**
 * Runs the recipe for the rule on the mapped span. `null` means the rule has no deterministic
 * recipe.
 */
export function planFix(request: FixRequest): RecipeOutcome | null {
  const { rule, span, files } = request;
  if (rule === 'color-contrast') return planContrast(request);
  if (!ELEMENT_RULES.has(rule)) return null;
  if (span.kind !== 'element') {
    return refuse('wrong-element', `${rule} is fixed on an element, not on a ${span.kind}`);
  }
  const source = files.get(span.file);
  if (source === undefined) return refuse('wrong-file', `${span.file} is not in the theme`);
  const parsed = parseThemeFile(span.file, source);
  if (!parsed.ok) {
    return refuse('wrong-file', `${span.file} does not parse: ${parsed.error.message}`);
  }
  return runElementRecipe(
    rule,
    parsed.file,
    { file: span.file, start: span.start },
    request.params ?? {},
  );
}
