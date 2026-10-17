/**
 * Empty links (WCAG 2.4.4, 4.1.2): visually hidden text from a translation key as the link's
 * last child (PLAN §12), the pattern Dawn uses for its social icon links.
 */
import { NodeTypes } from '@shopify/liquid-html-parser';
import { insertLastChild } from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { translationOutput, type TranslationRequirement } from '../translations.ts';
import { attributeEvidence, contentEvidence } from './name.ts';
import {
  DAWN_VISUALLY_HIDDEN_CLASS,
  alreadyFixed,
  fixed,
  labelProblem,
  locate,
  refuse,
  type Recipe,
  type RecipeTarget,
} from './types.ts';

export interface LabelParams {
  /** The translation key and English text of the label. */
  readonly label: TranslationRequirement;
  /** The theme's visually hidden class; defaults to Dawn's `visually-hidden`. */
  readonly visuallyHiddenClass?: string;
}

export const emptyLink: Recipe<LabelParams> = {
  id: 'empty-link',
  wcag: ['2.4.4', '4.1.2'],
  run(file: ParsedFile, target: RecipeTarget, params: LabelParams) {
    const className = params.visuallyHiddenClass ?? DAWN_VISUALLY_HIDDEN_CLASS;
    const problem = labelProblem(params.label, className);
    if (problem !== null) return refuse('invalid-parameter', problem);
    const located = locate(file, target, ['a']);
    if (!located.ok) return located.outcome;
    const { node } = located.element;
    if (node.type !== NodeTypes.HtmlElement)
      return refuse('wrong-element', 'the link has no end tag');
    const fromAttributes = attributeEvidence(node);
    if (fromAttributes.kind === 'refusal') return fromAttributes.outcome;
    if (fromAttributes.evidence.kind === 'named') {
      return alreadyFixed(`the link is named by ${fromAttributes.evidence.by}`);
    }
    const fromContent = contentEvidence(node.children);
    if (fromContent.kind === 'named') return alreadyFixed(`the link is named by ${fromContent.by}`);
    if (fromContent.kind === 'dynamic') return refuse('dynamic-content', fromContent.by);
    const span = `<span class="${className}">${translationOutput(params.label.key)}</span>`;
    return fixed([insertLastChild(file, node, span)], [params.label]);
  },
};
