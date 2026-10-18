// Checks that a golden span exists in its theme or store, and re-finds spans by their anchor
// after a theme file is edited (`node src/cli.ts spans --write`).
import {
  NodeTypes,
  toLiquidHtmlAST,
  type DocumentNode,
  type LiquidHtmlNode,
} from '@shopify/liquid-html-parser';
import { findNodeAtLocation, parseTree, type Node as JsonNode } from 'jsonc-parser';
import type { Span } from './golden.ts';
import type { StoreFixture } from './render/store.ts';
import type { Theme } from './render/theme.ts';

/** RFC 6901 pointer → path segments; numeric segments index arrays. */
export function pointerPath(pointer: string): (string | number)[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`"${pointer}" is not a JSON Pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((seg) => (/^(0|[1-9]\d*)$/.test(seg) ? Number(seg) : seg));
}

/** The JSON value a pointer names, with its offsets, or `null`. */
export function jsonValueAt(
  source: string,
  pointer: string,
): { start: number; end: number } | null {
  const tree: JsonNode | undefined = parseTree(source, [], { allowTrailingComma: true });
  if (tree === undefined) return null;
  const node = findNodeAtLocation(tree, pointerPath(pointer));
  if (node === undefined) return null;
  return { start: node.offset, end: node.offset + node.length };
}

interface ElementLike {
  readonly name: string | readonly LiquidHtmlNode[];
  readonly blockStartPosition: { readonly start: number; readonly end: number };
}

function children(node: LiquidHtmlNode): readonly LiquidHtmlNode[] {
  if (
    node.type === NodeTypes.Document ||
    node.type === NodeTypes.HtmlElement ||
    node.type === NodeTypes.LiquidBranch
  ) {
    return node.children;
  }
  if (node.type === NodeTypes.LiquidTag) return node.children ?? [];
  return [];
}

function isElement(node: LiquidHtmlNode): node is LiquidHtmlNode & ElementLike {
  return (
    node.type === NodeTypes.HtmlElement ||
    node.type === NodeTypes.HtmlVoidElement ||
    node.type === NodeTypes.HtmlSelfClosingElement ||
    node.type === NodeTypes.HtmlRawNode
  );
}

/**
 * Every element's start offset and lowercase tag name, walking the same nodes as
 * `packages/liquid-patch` (`elements` in src/html.ts at 551b200): HTML elements under the
 * document, HTML elements, Liquid branches and Liquid block tags.
 */
export function elementStarts(source: string): Map<number, string> {
  const ast: DocumentNode = toLiquidHtmlAST(source);
  const starts = new Map<number, string>();
  const visit = (node: LiquidHtmlNode): void => {
    for (const child of children(node)) {
      if (isElement(child)) {
        const name =
          typeof child.name === 'string'
            ? child.name
            : child.name.length === 1 && child.name[0]?.type === NodeTypes.TextNode
              ? child.name[0].value
              : null;
        if (name !== null) starts.set(child.blockStartPosition.start, name.toLowerCase());
      }
      visit(child);
    }
  };
  visit(ast);
  return starts;
}

/** Offsets where `needle` occurs in `haystack`. */
export function occurrencesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') return found;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    found.push(i);
  }
  return found;
}

/** The text of a store field a data span names, or `null` when there is no such field. */
export function storeField(store: StoreFixture, resource: string, field: string): string | null {
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(resource);
  if (match === null) return null;
  const [, type, idText] = match;
  if (type === undefined) return null;
  const id = Number(idText);
  switch (type) {
    case 'Product': {
      const product = store.products.find((p) => p.id === id);
      if (product === undefined) return null;
      if (field === 'descriptionHtml') return product.description;
      if (field === 'title') return product.title;
      return null;
    }
    case 'MediaImage': {
      const media = store.products.flatMap((p) => p.media).find((m) => m.id === id);
      return media !== undefined && field === 'alt' ? media.alt : null;
    }
    case 'Article': {
      const article = store.blogs.flatMap((b) => b.articles).find((a) => a.id === id);
      return article !== undefined && field === 'body' ? article.content : null;
    }
    case 'Page': {
      const page = store.pages.find((p) => p.id === id);
      return page !== undefined && field === 'body' ? page.content : null;
    }
    default:
      return null;
  }
}

/** Why the span does not hold in the theme or store, or `null` when it does. */
export function spanProblem(
  span: Span,
  theme: Theme | null,
  store: StoreFixture | null,
): string | null {
  if (span.kind === 'data') {
    if (store === null) return 'a data span needs a store';
    const value = storeField(store, span.resource, span.field);
    if (value === null) return `${span.resource} has no field ${span.field} in the store`;
    if (span.start === undefined || span.end === undefined) return null;
    if (span.end > value.length || span.start >= span.end) return 'offsets lie outside the value';
    if (value.slice(span.start, span.end) !== span.anchor) {
      return `the value between the offsets is not the anchor`;
    }
    return null;
  }
  if (theme === null) return 'a theme span needs a theme';
  const source = theme.files.get(span.file);
  if (source === undefined) return `${span.file} does not exist in ${theme.name}`;
  switch (span.kind) {
    case 'element': {
      const tag = elementStarts(source).get(span.start);
      if (tag === undefined) return `no element's start tag begins at offset ${String(span.start)}`;
      if (tag !== span.tag)
        return `the element at offset ${String(span.start)} is <${tag}>, not <${span.tag}>`;
      return anchorProblem(source, span.start, span.anchor);
    }
    case 'css-declaration': {
      if (source.slice(span.start, span.end) !== span.anchor) {
        return 'the text between the offsets is not the anchor';
      }
      if (!new RegExp(`^${span.property}\\s*:`).test(span.anchor)) {
        return `the declaration does not set ${span.property}`;
      }
      return occurrencesOf(source, span.anchor).length === 1
        ? null
        : 'the anchor occurs more than once in the file';
    }
    case 'json-value': {
      const value = jsonValueAt(source, span.pointer);
      if (value === null) return `${span.pointer} does not exist in ${span.file}`;
      if (value.start !== span.start || value.end !== span.end) {
        return `${span.pointer} spans [${String(value.start)}, ${String(value.end)}), not [${String(span.start)}, ${String(span.end)})`;
      }
      return null;
    }
  }
}

function anchorProblem(source: string, start: number, anchor: string): string | null {
  if (!source.startsWith(anchor, start)) return 'the anchor is not the text at the start offset';
  return occurrencesOf(source, anchor).length === 1
    ? null
    : 'the anchor occurs more than once in the file';
}

/** The span with its offsets re-found from its anchor or pointer; `null` when that is not unique. */
export function relocate(span: Span, theme: Theme | null, store: StoreFixture | null): Span | null {
  if (span.kind === 'data') {
    if (span.anchor === undefined || store === null) return span;
    const value = storeField(store, span.resource, span.field);
    const hits = value === null ? [] : occurrencesOf(value, span.anchor);
    const [start, ...rest] = hits;
    if (start === undefined || rest.length > 0) return null;
    return { ...span, start, end: start + span.anchor.length };
  }
  const source = theme?.files.get(span.file);
  if (source === undefined) return null;
  if (span.kind === 'json-value') {
    const value = jsonValueAt(source, span.pointer);
    return value === null ? null : { ...span, ...value };
  }
  const [start, ...rest] = occurrencesOf(source, span.anchor);
  if (start === undefined || rest.length > 0) return null;
  return span.kind === 'element'
    ? { ...span, start }
    : { ...span, start, end: start + span.anchor.length };
}
