/**
 * Missing form labels (WCAG 1.3.1, 4.1.2): a visually hidden `<label for>` from a translation
 * key just before the control, adding an id only when the control has none (PLAN §12).
 */
import { NodeTypes, type LiquidHtmlNode } from '@shopify/liquid-html-parser';
import type { Edit } from '../edits.ts';
import {
  attribute,
  elementName,
  elements,
  findAttribute,
  insertAttribute,
  insertBefore,
  rawValue,
  replaceAttribute,
  staticValue,
} from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { translationOutput } from '../translations.ts';
import type { LabelParams } from './empty-link.ts';
import { attributeEvidence } from './name.ts';
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

export interface FormLabelParams extends LabelParams {
  /**
   * The id to give a control that has none. May contain Liquid output, such as
   * `Quantity-{{ forloop.index }}`, and must when the control repeats on a page.
   */
  readonly id?: string;
}

/** Input types that take no label (https://html.spec.whatwg.org/multipage/input.html). */
const NOT_LABELABLE: ReadonlySet<string> = new Set([
  'hidden',
  'submit',
  'reset',
  'button',
  'image',
]);
const LOOP_TAGS: ReadonlySet<string> = new Set(['for', 'tablerow']);

/** Liquid output segments are allowed in a caller's id; the rest must be id characters. */
function idProblem(id: string): string | null {
  const plain = id.replace(/\{\{[^}]*\}\}/gu, '');
  if (id.trim() === '' || /["<>]/u.test(id) || !/^[A-Za-z0-9_:.-]*$/u.test(plain)) {
    return `"${id}" is not a usable id`;
  }
  return null;
}

function base(name: string | null): string {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return `Field-${cleaned === '' ? 'input' : cleaned}`;
}

/** An id unique per rendered instance, from the file's location; `null` when none is safe. */
function derivedId(file: ParsedFile, name: string | null): string | null {
  if (file.path.startsWith('sections/')) return `${base(name)}-{{ section.id }}`;
  if (file.path.startsWith('blocks/')) return `${base(name)}-{{ block.id }}`;
  if (file.path.startsWith('layout/') || file.path.startsWith('templates/')) return base(name);
  return null;
}

function inLoop(ancestors: readonly LiquidHtmlNode[]): boolean {
  return ancestors.some((a) => a.type === NodeTypes.LiquidTag && LOOP_TAGS.has(a.name));
}

export const formLabel: Recipe<FormLabelParams> = {
  id: 'form-label',
  wcag: ['1.3.1', '4.1.2'],
  run(file: ParsedFile, target: RecipeTarget, params: FormLabelParams) {
    const className = params.visuallyHiddenClass ?? DAWN_VISUALLY_HIDDEN_CLASS;
    const problem =
      labelProblem(params.label, className) ??
      (params.id === undefined ? null : idProblem(params.id));
    if (problem !== null) return refuse('invalid-parameter', problem);
    const located = locate(file, target, ['input', 'select', 'textarea']);
    if (!located.ok) return located.outcome;
    const { node, ancestors } = located.element;

    if (elementName(node) === 'input') {
      const type = findAttribute(node, 'type');
      const value = type === null || type.conditional ? null : staticValue(type.attr);
      if (value !== null && NOT_LABELABLE.has(value.trim().toLowerCase())) {
        return refuse('not-labelable', `<input type="${value}"> takes no label`);
      }
    }
    const fromAttributes = attributeEvidence(node);
    if (fromAttributes.kind === 'refusal') return fromAttributes.outcome;
    if (fromAttributes.evidence.kind === 'named') {
      return alreadyFixed(`the control is named by ${fromAttributes.evidence.by}`);
    }
    if (ancestors.some((a) => a.type === NodeTypes.HtmlElement && elementName(a) === 'label')) {
      return alreadyFixed('the control is inside a <label>');
    }

    const idAttr = findAttribute(node, 'id');
    if (idAttr?.conditional === true) {
      return refuse('conditional-attribute', 'the id is set inside a Liquid tag');
    }
    const currentId = idAttr === null ? '' : rawValue(file, idAttr.attr).trim();
    if (currentId.includes('"')) {
      return refuse('liquid-in-attribute', 'the id holds a double quote that for="" cannot repeat');
    }
    const all = elements(file.ast);
    if (currentId !== '') {
      const labelled = all.some((e) => {
        if (elementName(e.node) !== 'label') return false;
        const forAttr = findAttribute(e.node, 'for');
        return forAttr !== null && rawValue(file, forAttr.attr).trim() === currentId;
      });
      if (labelled) return alreadyFixed(`a <label for="${currentId}"> exists`);
    }

    const edits: Edit[] = [];
    let id = currentId;
    if (id === '') {
      const nameAttr = findAttribute(node, 'name');
      const name = nameAttr === null || nameAttr.conditional ? null : staticValue(nameAttr.attr);
      const chosen = params.id ?? derivedId(file, name);
      if (chosen === null) {
        return refuse(
          'needs-unique-id',
          `${file.path} may render more than once per page; pass an id`,
        );
      }
      // A derived id is unique per section or block, not per loop iteration.
      if (inLoop(ancestors) && params.id?.includes('{{') !== true) {
        return refuse(
          'needs-unique-id',
          'the control is inside a loop; pass an id with Liquid output',
        );
      }
      const taken = all.some((e) => {
        const other = findAttribute(e.node, 'id');
        return other !== null && rawValue(file, other.attr).trim() === chosen;
      });
      if (taken) return refuse('id-conflict', `id="${chosen}" is already used in ${file.path}`);
      id = chosen;
      const wanted = attribute('id', id);
      edits.push(
        idAttr === null
          ? insertAttribute(file, node, wanted)
          : replaceAttribute(file, idAttr.attr, wanted),
      );
    }
    const label = `<label for="${id}" class="${className}">${translationOutput(params.label.key)}</label>`;
    edits.push(insertBefore(file, node, label));
    return fixed(edits, [params.label]);
  },
};
