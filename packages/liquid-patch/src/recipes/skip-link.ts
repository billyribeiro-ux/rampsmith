/**
 * No way to bypass repeated blocks (WCAG 2.4.1): a skip link to the main landmark, as the
 * first content of `<body>`, hidden until focused (PLAN §12). The CSS that reveals it on focus
 * is written into `<head>` with the link, so the fix does not depend on the theme's CSS.
 */
import { NodeTypes } from '@shopify/liquid-html-parser';
import type { Edit } from '../edits.ts';
import {
  attribute,
  elementName,
  elements,
  findAttribute,
  insertAttribute,
  insertFirstChild,
  insertLastChild,
  replaceAttribute,
  staticValue,
  type LocatedElement,
} from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import { translationOutput, type TranslationRequirement } from '../translations.ts';
import {
  alreadyFixed,
  fixed,
  labelProblem,
  locate,
  refuse,
  type Recipe,
  type RecipeTarget,
} from './types.ts';

export interface SkipLinkParams {
  /** Defaults to Dawn's key and English text. */
  readonly label?: TranslationRequirement;
  /** The id given to the main landmark when it has none. */
  readonly mainId?: string;
  /** The skip link's class; the inserted CSS targets it. */
  readonly className?: string;
}

export const SKIP_LINK_LABEL: TranslationRequirement = {
  key: 'accessibility.skip_to_text',
  text: 'Skip to content',
};
/** Dawn's id for its main landmark. */
const DEFAULT_MAIN_ID = 'MainContent';
const DEFAULT_CLASS = 'rampsmith-skip-link';

const LAYOUT_FILE = /^layout\/[^/]+\.liquid$/u;
const ID = /^[A-Za-z][A-Za-z0-9_:.-]*$/u;

/**
 * Hidden with the clip pattern until focused, then shown at the top left in black on white
 * (21:1 contrast), keeping the browser's own focus outline.
 */
function styleLines(className: string): string[] {
  return [
    '<style>',
    `  .${className} { position: absolute; z-index: 9999; top: 0; left: 0; padding: 0.75rem 1rem; background: #fff; color: #000; text-decoration: underline; }`,
    `  .${className}:not(:focus) { width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }`,
    '</style>',
  ];
}

function isMain(e: LocatedElement): boolean {
  if (elementName(e.node) === 'main') return true;
  const role = findAttribute(e.node, 'role');
  return role !== null && !role.conditional && staticValue(role.attr)?.trim() === 'main';
}

export const skipLink: Recipe<SkipLinkParams> = {
  id: 'skip-link',
  wcag: ['2.4.1'],
  run(file: ParsedFile, target: RecipeTarget, params: SkipLinkParams) {
    const label = params.label ?? SKIP_LINK_LABEL;
    const className = params.className ?? DEFAULT_CLASS;
    const problem = labelProblem(label, className);
    if (problem !== null) return refuse('invalid-parameter', problem);
    const fallbackId = params.mainId ?? DEFAULT_MAIN_ID;
    if (!ID.test(fallbackId)) return refuse('invalid-parameter', `"${fallbackId}" is not an id`);
    if (!LAYOUT_FILE.test(file.path)) {
      return refuse('wrong-file', `the skip link belongs in layout/*.liquid, not ${file.path}`);
    }
    const located = locate(file, target, ['body']);
    if (!located.ok) return located.outcome;
    const body = located.element.node;
    if (body.type !== NodeTypes.HtmlElement)
      return refuse('wrong-element', '<body> has no end tag');

    const all = elements(file.ast);
    const main = all.find(isMain);
    if (main === undefined) {
      return refuse('main-landmark-not-found', `no <main> or role="main" in ${file.path}`);
    }
    const edits: Edit[] = [];
    const idAttr = findAttribute(main.node, 'id');
    let mainId: string;
    if (idAttr?.conditional === true) {
      return refuse('conditional-attribute', 'the main landmark id is set inside a Liquid tag');
    }
    const idText = idAttr === null ? '' : staticValue(idAttr.attr);
    if (idText === null) {
      return refuse('liquid-in-attribute', 'the main landmark id is printed by Liquid');
    }
    if (idText.trim() !== '') {
      mainId = idText.trim();
    } else {
      mainId = fallbackId;
      const taken = all.some((e) => {
        const id = findAttribute(e.node, 'id');
        return id !== null && staticValue(id.attr)?.trim() === mainId;
      });
      if (taken) return refuse('id-conflict', `id="${mainId}" is already used in ${file.path}`);
      const wanted = attribute('id', mainId);
      edits.push(
        idAttr === null
          ? insertAttribute(file, main.node, wanted)
          : replaceAttribute(file, idAttr.attr, wanted),
      );
    }

    const mainStart = main.node.blockStartPosition.start;
    const hasLink = all.some((e) => {
      if (elementName(e.node) !== 'a' || e.node.blockStartPosition.start >= mainStart) return false;
      const href = findAttribute(e.node, 'href');
      return href !== null && staticValue(href.attr)?.trim() === `#${mainId}`;
    });
    if (!hasLink) {
      const head = all.find((e) => elementName(e.node) === 'head')?.node;
      if (head?.type !== NodeTypes.HtmlElement) {
        return refuse('head-not-found', `no <head> element in ${file.path} for the skip link CSS`);
      }
      edits.push(
        insertFirstChild(
          file,
          body,
          `<a class="${className}" href="#${mainId}">${translationOutput(label.key)}</a>`,
        ),
        insertLastChild(file, head, styleLines(className)),
      );
    }
    if (edits.length === 0) {
      return alreadyFixed(`a link to #${mainId} already comes before the main landmark`);
    }
    return fixed(edits, hasLink ? [] : [label]);
  },
};
