// Checks that a golden span exists in its theme or store, and re-finds spans by their anchor
// after a theme file is edited (`node src/cli.ts spans --write`).
import {
  NodeTypes,
  toLiquidHtmlAST,
  type DocumentNode,
  type LiquidHtmlNode,
} from '@shopify/liquid-html-parser';
import { parseTree, type Node as JsonNode } from 'jsonc-parser';
import type { Span } from './golden.ts';
import type { StoreFixture } from './render/store.ts';
import type { Theme } from './render/theme.ts';

/** RFC 6901 pointer → unescaped reference tokens. */
export function pointerPath(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`"${pointer}" is not a JSON Pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * The JSON value a pointer names, with its offsets, or `null`. Each token is resolved against
 * the node it applies to: an object member by key (numeric block ids such as
 * `"1585245264519"` stay keys) or an array element by index. A string value's span includes its
 * quotes, as jsonc-parser reports it.
 */
export function jsonValueAt(
  source: string,
  pointer: string,
): { start: number; end: number } | null {
  let node: JsonNode | undefined = parseTree(source, [], { allowTrailingComma: true });
  for (const token of pointerPath(pointer)) {
    if (node === undefined) return null;
    if (node.type === 'object') {
      const member: JsonNode | undefined = (node.children ?? []).find(
        (property) => property.children?.[0]?.value === token,
      );
      node = member?.children?.[1];
    } else if (node.type === 'array' && /^(0|[1-9]\d*)$/.test(token)) {
      node = node.children?.[Number(token)];
    } else {
      return null;
    }
  }
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
    if (span.end > value.length || span.start > span.end) return 'offsets lie outside the value';
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
      const found = cssDeclaration(source, span.selector, span.anchor);
      if (typeof found === 'string') return found;
      return found === span.start
        ? null
        : `the declaration in ${span.selector} starts at ${String(found)}`;
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
    if (value === null) return null;
    if (span.anchor === '') return value === '' ? { ...span, start: 0, end: 0 } : null;
    const [start, ...rest] = occurrencesOf(value, span.anchor);
    if (start === undefined || rest.length > 0) return null;
    return { ...span, start, end: start + span.anchor.length };
  }
  const source = theme?.files.get(span.file);
  if (source === undefined) return null;
  if (span.kind === 'json-value') {
    const value = jsonValueAt(source, span.pointer);
    return value === null ? null : { ...span, ...value };
  }
  if (span.kind === 'css-declaration') {
    const start = cssDeclaration(source, span.selector, span.anchor);
    return typeof start === 'string' ? null : { ...span, start, end: start + span.anchor.length };
  }
  const [start, ...rest] = occurrencesOf(source, span.anchor);
  if (start === undefined || rest.length > 0) return null;
  // The anchor must begin an element with the span's tag, not sit in a comment or attribute.
  return elementStarts(source).get(start) === span.tag ? { ...span, start } : null;
}

/** A CSS rule: its selector as written (comments removed, whitespace collapsed) and body offsets. */
interface CssRule {
  readonly selector: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

function normalizeSelector(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/**
 * Every brace block of a stylesheet with its selector, in closing order. Comments are skipped,
 * and so is Liquid (`{{ ... }}`, `{% ... %}`) in a `.css.liquid` asset or around a
 * `{% stylesheet %}` body, whose braces are not CSS braces. At-rule blocks such as `@media` are
 * returned too, under their prelude, and the rules inside them under their own selectors.
 */
function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const open: { selectorStart: number; bodyStart: number }[] = [];
  let boundary = 0;
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith('{{', i) || source.startsWith('{%', i)) {
      const tag = source.startsWith('{%', i);
      const close = source.indexOf(tag ? '%}' : '}}', i + 2);
      i = close === -1 ? source.length : close + 2;
      // A Liquid tag such as {% stylesheet %} ends whatever came before; output may sit in a value.
      if (tag) boundary = i;
      continue;
    }
    const ch = source.charAt(i);
    if (ch === '{') {
      open.push({ selectorStart: boundary, bodyStart: i + 1 });
      boundary = i + 1;
    } else if (ch === '}') {
      const rule = open.pop();
      if (rule !== undefined) {
        const selector = normalizeSelector(source.slice(rule.selectorStart, rule.bodyStart - 1));
        rules.push({ selector, bodyStart: rule.bodyStart, bodyEnd: i });
      }
      boundary = i + 1;
    } else if (ch === ';' && open.length === 0) {
      boundary = i + 1;
    }
    i += 1;
  }
  return rules;
}

/**
 * The offset of `declaration` inside the one rule whose selector is `selector`, or why there
 * is none. Selectors compare whole, after removing comments and collapsing whitespace, so
 * `.btn` does not match `.card .btn` or `.a, .btn`. The declaration must start the rule body or
 * follow a `;`, so `color: red` is not found inside `background-color: red`, and must occur
 * once in the rule.
 */
export function cssDeclaration(
  source: string,
  selector: string,
  declaration: string,
): number | string {
  const wanted = normalizeSelector(selector);
  const matches = cssRules(source).filter((r) => r.selector === wanted);
  const [rule, ...others] = matches;
  if (rule === undefined) return `no rule with the selector ${selector}`;
  if (others.length > 0) return `the selector ${selector} begins more than one rule`;
  const body = source.slice(rule.bodyStart, rule.bodyEnd);
  const hits = occurrencesOf(body, declaration).filter((at) =>
    /(^|[;{])\s*$/.test(body.slice(0, at)),
  );
  const [hit, ...more] = hits;
  if (hit === undefined) return `the rule ${selector} has no declaration ${declaration}`;
  if (more.length > 0) return `the declaration ${declaration} occurs more than once in ${selector}`;
  return rule.bodyStart + hit;
}
