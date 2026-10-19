/**
 * Empty buttons (WCAG 4.1.2): `aria-label` from a translation key (PLAN §12), the usual pattern
 * for icon-only buttons such as search and close. The `t` filter escapes the text, so it is safe
 * inside the double-quoted attribute (ADR-103).
 */
import { NodeTypes } from '@shopify/liquid-html-parser';
import { attribute, findAttribute, insertAttribute, replaceAttribute } from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { translationOutput } from '../translations.ts';
import type { LabelParams } from './empty-link.ts';
import { attributeEvidence, contentEvidence } from './name.ts';
import {
  alreadyFixed,
  fixed,
  labelProblem,
  locate,
  refuse,
  type Recipe,
  type RecipeTarget,
} from './types.ts';

export type ButtonParams = Pick<LabelParams, 'label'>;

export const emptyButton: Recipe<ButtonParams> = {
  id: 'empty-button',
  wcag: ['4.1.2'],
  run(file: ParsedFile, target: RecipeTarget, params: ButtonParams) {
    const problem = labelProblem(params.label);
    if (problem !== null) return refuse('invalid-parameter', problem);
    const located = locate(file, target, ['button']);
    if (!located.ok) return located.outcome;
    const { node } = located.element;
    if (node.type !== NodeTypes.HtmlElement) {
      return refuse('wrong-element', 'the button has no end tag');
    }
    const fromAttributes = attributeEvidence(node);
    if (fromAttributes.kind === 'refusal') return fromAttributes.outcome;
    if (fromAttributes.evidence.kind === 'named') {
      return alreadyFixed(`the button is named by ${fromAttributes.evidence.by}`);
    }
    const fromContent = contentEvidence(node.children);
    if (fromContent.kind === 'named')
      return alreadyFixed(`the button is named by ${fromContent.by}`);
    if (fromContent.kind === 'dynamic') return refuse('dynamic-content', fromContent.by);
    const wanted = attribute('aria-label', translationOutput(params.label.key));
    // An empty aria-label="" is replaced; attributeEvidence has refused every other value.
    const existing = findAttribute(node, 'aria-label');
    const edit =
      existing === null
        ? insertAttribute(file, node, wanted)
        : replaceAttribute(file, existing.attr, wanted);
    return fixed([edit], [params.label]);
  },
};
