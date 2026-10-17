/**
 * Reading HTML elements and attributes out of the Liquid AST, and building span edits that
 * insert markup in the file's own style: the indentation and line endings already there.
 */
import {
  NodeTypes,
  type AttrDoubleQuoted,
  type AttrEmpty,
  type AttrSingleQuoted,
  type AttrUnquoted,
  type AttributeNode,
  type DocumentNode,
  type HtmlElement,
  type HtmlRawNode,
  type HtmlSelfClosingElement,
  type HtmlVoidElement,
  type LiquidHtmlNode,
  type LiquidVariableOutput,
} from '@shopify/liquid-html-parser';
import type { Edit } from './edits.ts';
import type { ParsedFile } from './parse.ts';

export type ElementNode = HtmlElement | HtmlVoidElement | HtmlSelfClosingElement | HtmlRawNode;
export type HtmlAttribute = AttrDoubleQuoted | AttrSingleQuoted | AttrUnquoted | AttrEmpty;

export interface LocatedElement {
  readonly node: ElementNode;
  /** Outermost first; includes Liquid tags and branches, not the document. */
  readonly ancestors: readonly LiquidHtmlNode[];
}

function isElement(node: LiquidHtmlNode): node is ElementNode {
  return (
    node.type === NodeTypes.HtmlElement ||
    node.type === NodeTypes.HtmlVoidElement ||
    node.type === NodeTypes.HtmlSelfClosingElement ||
    node.type === NodeTypes.HtmlRawNode
  );
}

function childrenOf(node: LiquidHtmlNode): readonly LiquidHtmlNode[] {
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

/** Every element in document order, with its ancestors. */
export function elements(ast: DocumentNode): LocatedElement[] {
  const found: LocatedElement[] = [];
  const visit = (node: LiquidHtmlNode, ancestors: LiquidHtmlNode[]): void => {
    for (const child of childrenOf(node)) {
      if (isElement(child)) found.push({ node: child, ancestors: [...ancestors] });
      visit(child, [...ancestors, child]);
    }
  };
  visit(ast, []);
  return found;
}

/** The element whose start tag begins at `start` (the offset of its `<`), if any. */
export function elementAt(ast: DocumentNode, start: number): LocatedElement | null {
  return elements(ast).find((e) => e.node.blockStartPosition.start === start) ?? null;
}

/** The lowercase tag name, or `null` when part of the name is Liquid. */
export function elementName(node: ElementNode): string | null {
  if (typeof node.name === 'string') return node.name.toLowerCase();
  const [only, ...rest] = node.name;
  if (only === undefined || rest.length > 0 || only.type !== NodeTypes.TextNode) return null;
  return only.value.toLowerCase();
}

/** First element with that tag name, in document order. */
export function firstElement(ast: DocumentNode, name: string): LocatedElement | null {
  return elements(ast).find((e) => elementName(e.node) === name) ?? null;
}

function isHtmlAttribute(node: AttributeNode | LiquidHtmlNode): node is HtmlAttribute {
  return (
    node.type === NodeTypes.AttrDoubleQuoted ||
    node.type === NodeTypes.AttrSingleQuoted ||
    node.type === NodeTypes.AttrUnquoted ||
    node.type === NodeTypes.AttrEmpty
  );
}

/** The lowercase attribute name, or `null` when part of the name is Liquid. */
function attributeName(attr: HtmlAttribute): string | null {
  const [only, ...rest] = attr.name;
  if (only === undefined || rest.length > 0 || only.type !== NodeTypes.TextNode) return null;
  return only.value.toLowerCase();
}

export interface FoundAttribute {
  readonly attr: HtmlAttribute;
  /** True when the attribute sits inside a Liquid tag in the start tag, such as `{% if %}`. */
  readonly conditional: boolean;
}

/**
 * Finds an attribute by name: a plain one in the start tag first, then one written inside a
 * Liquid tag among the attributes. Attributes that Liquid output may print, such as
 * `{{ block.shopify_attributes }}`, cannot be seen and are not reported.
 */
export function findAttribute(node: ElementNode, name: string): FoundAttribute | null {
  for (const attr of node.attributes) {
    if (isHtmlAttribute(attr) && attributeName(attr) === name) return { attr, conditional: false };
  }
  const nested = (nodes: readonly LiquidHtmlNode[]): HtmlAttribute | null => {
    for (const child of nodes) {
      if (isHtmlAttribute(child) && attributeName(child) === name) return child;
      const deeper = nested(childrenOf(child));
      if (deeper !== null) return deeper;
    }
    return null;
  };
  for (const attr of node.attributes) {
    if (attr.type === NodeTypes.LiquidTag) {
      const hit = nested(attr.children ?? []);
      if (hit !== null) return { attr: hit, conditional: true };
    }
  }
  return null;
}

/** The attribute's value when it is plain text (`''` for `<x attr>`); `null` when it has Liquid. */
export function staticValue(attr: HtmlAttribute): string | null {
  if (attr.type === NodeTypes.AttrEmpty) return '';
  let text = '';
  for (const part of attr.value) {
    if (part.type !== NodeTypes.TextNode) return null;
    text += part.value;
  }
  return text;
}

/** The value exactly as written in the source, without quotes. */
export function rawValue(file: ParsedFile, attr: HtmlAttribute): string {
  if (attr.type === NodeTypes.AttrEmpty) return '';
  return file.source.slice(attr.attributePosition.start, attr.attributePosition.end);
}

/** The Liquid output nodes in an attribute value. */
export function valueOutputs(attr: HtmlAttribute): LiquidVariableOutput[] {
  if (attr.type === NodeTypes.AttrEmpty) return [];
  return attr.value.filter((part) => part.type === NodeTypes.LiquidVariableOutput);
}

/**
 * True for `{{ 'some.key' | t }}`, with or without more filters or arguments: output that
 * renders a theme translation.
 */
export function isTranslationOutput(node: LiquidVariableOutput): boolean {
  if (typeof node.markup === 'string') return false;
  const [first] = node.markup.filters;
  return node.markup.expression.type === NodeTypes.String && first?.name === 't';
}

/** End offset of the tag name inside the start tag. */
function nameEnd(node: ElementNode): number {
  if (typeof node.name === 'string') return node.blockStartPosition.start + 1 + node.name.length;
  const last = node.name.at(-1);
  return last === undefined ? node.blockStartPosition.start + 1 : last.position.end;
}

function lineEnding(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

/** Offset of the start of the line containing `offset`. */
function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/** The whitespace before `offset` on its line, or `null` if other text precedes it. */
function indentationBefore(source: string, offset: number): string | null {
  const prefix = source.slice(lineStart(source, offset), offset);
  return /^[ \t]*$/u.test(prefix) ? prefix : null;
}

/** One level of indentation, guessed from the surrounding indentation. */
function indentUnit(indentation: string): string {
  return indentation.includes('\t') ? '\t' : '  ';
}

/**
 * Inserts `text` (such as `alt=""`) as the last attribute of the start tag. The separator
 * copies the whitespace before the current last attribute when that whitespace starts a new
 * line, so attributes written one per line stay one per line.
 */
export function insertAttribute(file: ParsedFile, node: ElementNode, text: string): Edit {
  const last = node.attributes.at(-1);
  if (last === undefined) {
    const at = nameEnd(node);
    return { file: file.path, start: at, end: at, replacement: ` ${text}` };
  }
  let wsStart = last.position.start;
  while (wsStart > 0 && /\s/u.test(file.source.charAt(wsStart - 1))) wsStart -= 1;
  const whitespace = file.source.slice(wsStart, last.position.start);
  const newline = whitespace.lastIndexOf('\n');
  let separator = ' ';
  if (newline !== -1) {
    const from = newline > 0 && whitespace.charAt(newline - 1) === '\r' ? newline - 1 : newline;
    separator = whitespace.slice(from);
  }
  const at = last.position.end;
  return { file: file.path, start: at, end: at, replacement: `${separator}${text}` };
}

/** Replaces a whole attribute, name and value, with `text`. */
export function replaceAttribute(file: ParsedFile, attr: HtmlAttribute, text: string): Edit {
  return { file: file.path, start: attr.position.start, end: attr.position.end, replacement: text };
}

/**
 * The indentation of the first line of content after `from` that starts before `until`, if
 * that line holds something other than whitespace.
 */
function contentIndentation(source: string, from: number, until: number): string | null {
  const firstNewline = source.indexOf('\n', from);
  if (firstNewline === -1 || firstNewline >= until) return null;
  let cursor = firstNewline + 1;
  while (cursor < until) {
    const end = source.indexOf('\n', cursor);
    const lineEnd = end === -1 || end > until ? until : end;
    const line = source.slice(cursor, lineEnd).replace(/\r$/u, '');
    if (line.trim() !== '') {
      const match = /^[ \t]*/u.exec(line);
      return match?.[0] ?? '';
    }
    if (end === -1) break;
    cursor = end + 1;
  }
  return null;
}

/**
 * Inserts `markup` as the first child of an element. When the start tag ends its line, the
 * markup goes on its own line, indented like the element's first line of content.
 */
export function insertFirstChild(file: ParsedFile, node: HtmlElement, markup: string): Edit {
  const { source } = file;
  const at = node.blockStartPosition.end;
  const newlineAt = source.indexOf('\n', at);
  if (newlineAt === -1 || source.slice(at, newlineAt).trim() !== '') {
    return { file: file.path, start: at, end: at, replacement: markup };
  }
  const own = indentationBefore(source, node.blockStartPosition.start) ?? '';
  const indent =
    contentIndentation(source, at, node.blockEndPosition.start) ?? own + indentUnit(own);
  return {
    file: file.path,
    start: at,
    end: at,
    replacement: `${lineEnding(source)}${indent}${markup}`,
  };
}

/**
 * Inserts markup as the last child of an element, just before its end tag. When the end tag
 * starts its line, each line of markup goes on its own line above it, indented like the
 * content; otherwise the lines are joined in place.
 */
export function insertLastChild(
  file: ParsedFile,
  node: HtmlElement,
  markup: string | readonly string[],
): Edit {
  const { source } = file;
  const lines = typeof markup === 'string' ? [markup] : markup;
  const endTag = node.blockEndPosition.start;
  const own = indentationBefore(source, endTag);
  if (own === null) {
    return { file: file.path, start: endTag, end: endTag, replacement: lines.join('') };
  }
  const content = contentIndentation(source, node.blockStartPosition.end, endTag);
  const indent = content !== null && content.length > own.length ? content : own + indentUnit(own);
  const eol = lineEnding(source);
  const at = lineStart(source, endTag);
  return {
    file: file.path,
    start: at,
    end: at,
    replacement: lines.map((line) => `${indent}${line}${eol}`).join(''),
  };
}

/**
 * Inserts `markup` just before an element. When the element starts its line, the markup takes
 * that line and the element moves to the next one with the same indentation.
 */
export function insertBefore(file: ParsedFile, node: ElementNode, markup: string): Edit {
  const at = node.blockStartPosition.start;
  const own = indentationBefore(file.source, at);
  const replacement = own === null ? markup : `${markup}${lineEnding(file.source)}${own}`;
  return { file: file.path, start: at, end: at, replacement };
}

/** Builds an attribute with a double-quoted value; the value must not contain `"`. */
export function attribute(name: string, value: string): string {
  return `${name}="${value}"`;
}
