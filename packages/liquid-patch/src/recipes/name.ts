/**
 * Static evidence of an accessible name in a link's or a button's source (ADR-102). The
 * scanner already saw the rendered element without a name; these rules decide whether the
 * source shows a name anyway (the fix is present), shows none (safe to add one), or holds
 * Liquid that may print text (a static fix could give the element two names, so refuse).
 */
import {
  NodeTypes,
  type LiquidHtmlNode,
  type LiquidTag,
  type LiquidVariableOutput,
} from '@shopify/liquid-html-parser';
import {
  elementName,
  findAttribute,
  isTranslationOutput,
  staticValue,
  valueOutputs,
  type ElementNode,
} from '../html.ts';
import { refuse, type RecipeOutcome } from './types.ts';

export type NameEvidence =
  | { readonly kind: 'named'; readonly by: string }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'dynamic'; readonly by: string };

const UNNAMED: NameEvidence = { kind: 'unnamed' };

/** Output filters that print markup without text: inline SVG icons and placeholders. */
const ICON_FILTERS: ReadonlySet<string> = new Set(['inline_asset_content', 'placeholder_svg_tag']);
/** Liquid tags that print nothing. */
const SILENT_TAGS: ReadonlySet<string> = new Set(['assign', 'capture', '#']);
/** Control-flow tags whose branches are inspected. */
const BRANCHING_TAGS: ReadonlySet<string> = new Set(['if', 'unless', 'case', 'for', 'tablerow']);
const SILENT_RAW_TAGS: ReadonlySet<string> = new Set([
  'comment',
  'doc',
  'style',
  'stylesheet',
  'javascript',
  'schema',
]);

function combine(all: readonly NameEvidence[]): NameEvidence {
  return all.find((e) => e.kind === 'named') ?? all.find((e) => e.kind === 'dynamic') ?? UNNAMED;
}

function tagEvidence(node: LiquidTag): NameEvidence {
  if (SILENT_TAGS.has(node.name)) return UNNAMED;
  if (node.name === 'render' || node.name === 'include') {
    const markup = node.markup;
    const snippet = typeof markup !== 'string' && 'snippet' in markup ? markup.snippet : null;
    if (snippet?.type === NodeTypes.String && snippet.value.startsWith('icon')) return UNNAMED;
    return { kind: 'dynamic', by: `{% ${node.name} %} may print text` };
  }
  if (BRANCHING_TAGS.has(node.name)) {
    const inner = contentEvidence(node.children ?? []);
    return inner.kind === 'unnamed'
      ? UNNAMED
      : { kind: 'dynamic', by: `text inside {% ${node.name} %} is conditional` };
  }
  return { kind: 'dynamic', by: `{% ${node.name} %} may print text` };
}

function elementEvidence(node: ElementNode): NameEvidence {
  const hidden = findAttribute(node, 'aria-hidden');
  if (hidden !== null && !hidden.conditional && staticValue(hidden.attr) === 'true') {
    return UNNAMED;
  }
  const name = elementName(node);
  if (node.type === NodeTypes.HtmlRawNode) {
    if (name !== 'svg') return UNNAMED;
    const label = findAttribute(node, 'aria-label');
    if (label !== null && (staticValue(label.attr) ?? 'x').trim() !== '') {
      return { kind: 'named', by: 'an aria-label on the svg' };
    }
    return /<title[^>]*>\s*[^<\s]/u.test(node.body.value)
      ? { kind: 'named', by: 'an svg title' }
      : UNNAMED;
  }
  if (name === 'img') {
    const alt = findAttribute(node, 'alt');
    if (alt === null) return UNNAMED;
    const text = staticValue(alt.attr);
    if (text === null) return { kind: 'dynamic', by: 'an image alt printed by Liquid' };
    return text.trim() === '' ? UNNAMED : { kind: 'named', by: 'an image alt' };
  }
  return node.type === NodeTypes.HtmlElement ? contentEvidence(node.children) : UNNAMED;
}

function outputEvidence(node: LiquidVariableOutput): NameEvidence {
  if (isTranslationOutput(node)) return { kind: 'named', by: 'a translation' };
  if (typeof node.markup === 'string') return { kind: 'dynamic', by: 'Liquid output' };
  const { expression, filters } = node.markup;
  const icon =
    filters.some((f) => ICON_FILTERS.has(f.name)) ||
    (expression.type === NodeTypes.String && expression.value.endsWith('.svg'));
  return icon ? UNNAMED : { kind: 'dynamic', by: 'Liquid output may print text' };
}

function nodeEvidence(node: LiquidHtmlNode): NameEvidence {
  if (node.type === NodeTypes.TextNode) {
    return node.value.trim() === '' ? UNNAMED : { kind: 'named', by: 'text content' };
  }
  if (node.type === NodeTypes.LiquidVariableOutput) return outputEvidence(node);
  if (node.type === NodeTypes.LiquidTag) return tagEvidence(node);
  if (node.type === NodeTypes.LiquidBranch) return contentEvidence(node.children);
  if (node.type === NodeTypes.LiquidRawTag) {
    return SILENT_RAW_TAGS.has(node.name)
      ? UNNAMED
      : { kind: 'dynamic', by: `{% ${node.name} %} prints text` };
  }
  if (
    node.type === NodeTypes.HtmlElement ||
    node.type === NodeTypes.HtmlVoidElement ||
    node.type === NodeTypes.HtmlSelfClosingElement ||
    node.type === NodeTypes.HtmlRawNode
  ) {
    return elementEvidence(node);
  }
  // Comments and anything else print no text.
  return UNNAMED;
}

/** Evidence from an element's content, in document order. */
export function contentEvidence(nodes: readonly LiquidHtmlNode[]): NameEvidence {
  return combine(nodes.map(nodeEvidence));
}

export type AttributeEvidence =
  | { readonly kind: 'evidence'; readonly evidence: NameEvidence }
  | { readonly kind: 'refusal'; readonly outcome: RecipeOutcome };

/**
 * Evidence from `aria-labelledby`, `aria-label` and `title`. A translation printed into
 * `aria-label` counts as a name; other Liquid there, or any of the three inside a Liquid tag,
 * is refused because its rendered value cannot be judged from source.
 */
export function attributeEvidence(node: ElementNode): AttributeEvidence {
  for (const name of ['aria-labelledby', 'aria-label', 'title']) {
    const found = findAttribute(node, name);
    if (found === null) continue;
    if (found.conditional) {
      return {
        kind: 'refusal',
        outcome: refuse('conditional-attribute', `${name} is set inside a Liquid tag`),
      };
    }
    const text = staticValue(found.attr);
    if (text !== null) {
      if (text.trim() !== '') return { kind: 'evidence', evidence: { kind: 'named', by: name } };
      continue;
    }
    const outputs = valueOutputs(found.attr);
    if (name === 'aria-labelledby') {
      return { kind: 'evidence', evidence: { kind: 'named', by: name } };
    }
    if (outputs.length > 0 && outputs.every(isTranslationOutput)) {
      return { kind: 'evidence', evidence: { kind: 'named', by: `a translation in ${name}` } };
    }
    if (name === 'aria-label') {
      return {
        kind: 'refusal',
        outcome: refuse('liquid-in-attribute', 'aria-label already holds Liquid output'),
      };
    }
  }
  return { kind: 'evidence', evidence: UNNAMED };
}
