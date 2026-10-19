/**
 * Finding the source element a rendered element came from (PLAN §12, mapping step 3): search
 * the Liquid AST by tag, static attributes and class tokens, with Liquid output as a wildcard
 * (ADR-244).
 *
 * A source element can have produced the rendered one only if all of this holds:
 *
 * 1. the tag name is the same;
 * 2. every attribute the source names (outside a Liquid tag) is on the rendered element, and its
 *    value fits the source's text, with `{{ ... }}` and `{% ... %}` matching anything;
 * 3. every attribute on the rendered element is in the source, unless the source prints
 *    attributes through Liquid (`{{ block.shopify_attributes }}`, a Liquid tag among them);
 * 4. each run of plain text directly inside the source element is in the rendered text;
 * 5. the source's ancestor elements in the same file are, in order, among the rendered ancestors.
 *
 * What is left over is ranked by how much static evidence agreed. That count, not the position
 * or the order of the files, is what a confidence is made of.
 */
import {
  NodeTypes,
  type LiquidHtmlNode,
  type LiquidVariableOutput,
} from '@shopify/liquid-html-parser';
import {
  elementName,
  elements,
  isElement,
  type ElementNode,
  type HtmlAttribute,
  type LocatedElement,
} from '../html.ts';
import type { ElementSpan, RenderedElement, RenderedNode, Sibling } from './types.ts';
import type { ThemeIndex } from './theme.ts';

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  times: '×',
};

/** Decodes the character references HTML in theme files uses; unknown ones stay as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, dec, hex, name) => {
    if (typeof dec === 'string') return String.fromCodePoint(Number(dec));
    if (typeof hex === 'string') return String.fromCodePoint(Number.parseInt(hex, 16));
    return typeof name === 'string' ? (ENTITIES[name.toLowerCase()] ?? whole) : whole;
  });
}

function collapseSpace(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * A piece of an attribute value: text, or Liquid output. `lookup` is the object path of a plain
 * `{{ settings.x }}` output with no filter, whose value the theme's JSON may hold; `null` for
 * anything else Liquid prints.
 */
type Part = string | { readonly lookup: string | null };

/** Resolves an object path such as `settings.social_link` to the string it prints. */
export type Resolver = (lookup: string) => string | undefined;

interface AttributeDescription {
  readonly name: string;
  /** Inside a Liquid tag in the start tag: the attribute may not be printed. */
  readonly conditional: boolean;
  readonly parts: readonly Part[];
}

export interface ElementInfo {
  /** The tag name, or `null` when part of it is Liquid. */
  readonly tag: string | null;
  readonly attributes: readonly AttributeDescription[];
  /** True when the start tag prints attributes the AST cannot see. */
  readonly wildcard: boolean;
  /** Runs of plain text directly inside the element, collapsed and trimmed. */
  readonly text: readonly string[];
  /**
   * Liquid output directly inside the element, also through `{% if %}` and `{% for %}`: the
   * object path, such as `article.content`, and the names of its filters.
   */
  readonly outputs: readonly { readonly path: string; readonly filters: readonly string[] }[];
}

export interface SourceElement {
  readonly file: string;
  /** Offset of the `<` of the start tag. */
  readonly start: number;
  readonly info: ElementInfo;
  /** Ancestor elements in the same file, nearest first. */
  readonly ancestors: readonly ElementInfo[];
}

function isAttribute(node: LiquidHtmlNode): node is HtmlAttribute {
  return (
    node.type === NodeTypes.AttrDoubleQuoted ||
    node.type === NodeTypes.AttrSingleQuoted ||
    node.type === NodeTypes.AttrUnquoted ||
    node.type === NodeTypes.AttrEmpty
  );
}

function attributeName(attr: HtmlAttribute): string | null {
  const [only, ...rest] = attr.name;
  if (only === undefined || rest.length > 0 || only.type !== NodeTypes.TextNode) return null;
  return only.value.toLowerCase();
}

function valueParts(attr: HtmlAttribute): Part[] {
  if (attr.type === NodeTypes.AttrEmpty) return [''];
  return attr.value.map((part): Part => {
    if (part.type === NodeTypes.TextNode) return decodeEntities(part.value);
    if (part.type === NodeTypes.LiquidVariableOutput) {
      const found = lookupPath(part);
      return { lookup: found !== null && found.filters.length === 0 ? found.path : null };
    }
    return { lookup: null };
  });
}

function collectAttributes(
  nodes: readonly LiquidHtmlNode[],
  conditional: boolean,
  out: AttributeDescription[],
): boolean {
  let wildcard = false;
  for (const node of nodes) {
    if (isAttribute(node)) {
      const name = attributeName(node);
      if (name === null) wildcard = true;
      else out.push({ name, conditional, parts: valueParts(node) });
    } else if (node.type === NodeTypes.LiquidVariableOutput) {
      wildcard = true;
    } else if (node.type === NodeTypes.LiquidTag) {
      const inner = node.children ?? [];
      const branches = inner.flatMap((c) => (c.type === NodeTypes.LiquidBranch ? c.children : [c]));
      if (collectAttributes(branches, true, out)) wildcard = true;
    }
  }
  return wildcard;
}

function lookupPath(output: LiquidVariableOutput): { path: string; filters: string[] } | null {
  if (typeof output.markup === 'string') return null;
  const { expression, filters } = output.markup;
  if (expression.type !== NodeTypes.VariableLookup) return null;
  const parts = [
    expression.name ?? '',
    ...expression.lookups.map((l) => (l.type === NodeTypes.String ? l.value : '?')),
  ];
  return { path: parts.join('.'), filters: filters.map((f) => f.name) };
}

function collectOutputs(
  nodes: readonly LiquidHtmlNode[],
  out: { path: string; filters: string[] }[],
): void {
  for (const child of nodes) {
    if (child.type === NodeTypes.LiquidVariableOutput) {
      const found = lookupPath(child);
      if (found !== null) out.push(found);
    } else if (child.type === NodeTypes.LiquidTag) {
      collectOutputs(child.children ?? [], out);
    } else if (child.type === NodeTypes.LiquidBranch) {
      collectOutputs(child.children, out);
    }
  }
}

export function describeNode(node: ElementNode): ElementInfo {
  const attributes: AttributeDescription[] = [];
  const wildcard = collectAttributes(node.attributes, false, attributes);
  const text: string[] = [];
  const outputs: { path: string; filters: string[] }[] = [];
  if (node.type === NodeTypes.HtmlElement) {
    for (const child of node.children) {
      if (child.type !== NodeTypes.TextNode) continue;
      const piece = collapseSpace(decodeEntities(child.value)).trim();
      if (piece !== '') text.push(piece);
    }
    collectOutputs(node.children, outputs);
  }
  return { tag: elementName(node), attributes, wildcard, text, outputs };
}

function describe(file: string, located: LocatedElement): SourceElement {
  const ancestors = located.ancestors.filter(isElement).map(describeNode).reverse();
  return {
    file,
    start: located.node.blockStartPosition.start,
    info: describeNode(located.node),
    ancestors,
  };
}

const memo = new WeakMap<ThemeIndex, Map<string, readonly SourceElement[]>>();

/** Every element of a Liquid file in document order, described for matching. */
export function sourceElements(index: ThemeIndex, path: string): readonly SourceElement[] {
  let byFile = memo.get(index);
  if (byFile === undefined) {
    byFile = new Map();
    memo.set(index, byFile);
  }
  const cached = byFile.get(path);
  if (cached !== undefined) return cached;
  const file = index.liquid(path);
  const list = file === null ? [] : elements(file.ast).map((e) => describe(path, e));
  byFile.set(path, list);
  return list;
}

/** The text a part prints when it is known, `undefined` when only Liquid knows. */
function known(part: Part, resolve: Resolver | undefined): string | undefined {
  if (typeof part === 'string') return part;
  return part.lookup === null || resolve === undefined ? undefined : resolve(part.lookup);
}

/**
 * True when `rendered` fits the source value: its text exactly, its Liquid parts anything,
 * except a plain setting lookup whose value is known, which must print that value.
 */
function valueFits(
  parts: readonly Part[],
  rendered: string,
  name: string,
  resolve?: Resolver,
): boolean {
  const collapse = name === 'class' || name === 'style' || name === 'd';
  const normalise = (text: string): string => (collapse ? collapseSpace(text) : text);
  const pattern = parts
    .map((part) => {
      const text = known(part, resolve);
      return text === undefined ? '[\\s\\S]*' : escapeRegExp(normalise(text));
    })
    .join('');
  return new RegExp(`^${pattern}$`, 'u').test(normalise(rendered));
}

/** True when the value has no Liquid in it. */
function isStatic(parts: readonly Part[]): boolean {
  return parts.every((p) => typeof p === 'string');
}

interface Agreement {
  readonly ok: boolean;
  readonly points: number;
  readonly reasons: readonly string[];
}

const NO: Agreement = { ok: false, points: 0, reasons: [] };

/**
 * Whether a source element's tag and attributes can have produced `node`, and how many points
 * of static evidence agree. `strict` also requires every rendered attribute to be accounted for.
 */
export function attributesAgree(
  info: ElementInfo,
  node: Sibling,
  strict: boolean,
  resolve?: Resolver,
): Agreement {
  if (info.tag === null || info.tag !== node.tag) return NO;
  let points = 0;
  const reasons: string[] = [];
  const named = new Set<string>();
  for (const attr of info.attributes) {
    named.add(attr.name);
    const rendered = node.attributes[attr.name];
    if (rendered === undefined) {
      if (attr.conditional) continue;
      return NO;
    }
    if (!valueFits(attr.parts, rendered, attr.name, resolve)) return NO;
    if (!isStatic(attr.parts)) {
      const resolved = attr.parts.some(
        (p) => known(p, resolve) !== undefined && typeof p !== 'string',
      );
      if (resolved) {
        points += 1;
        reasons.push(`${attr.name} equals the value of its setting`);
      }
      continue;
    }
    if (attr.name === 'id') {
      points += 2;
      reasons.push(`id="${rendered}"`);
    } else if (attr.name === 'class') {
      const tokens = collapseSpace(rendered)
        .trim()
        .split(' ')
        .filter((t) => t !== '');
      points += Math.min(tokens.length, 3);
      reasons.push(`class="${collapseSpace(rendered).trim()}"`);
    } else {
      points += 1;
      reasons.push(
        `${attr.name}="${rendered.length > 40 ? `${rendered.slice(0, 40)}...` : rendered}"`,
      );
    }
  }
  if (strict && !info.wildcard) {
    for (const name of Object.keys(node.attributes)) {
      if (!named.has(name)) return NO;
    }
  }
  return { ok: true, points, reasons };
}

function ancestorsAgree(
  source: readonly ElementInfo[],
  rendered: readonly RenderedNode[],
  resolve: Resolver | undefined,
): number | null {
  let position = 0;
  let points = 0;
  for (const ancestor of source) {
    if (ancestor.tag === null) continue;
    let found = false;
    while (position < rendered.length) {
      const candidate = rendered[position];
      position += 1;
      if (candidate !== undefined && attributesAgree(ancestor, candidate, false, resolve).ok) {
        found = true;
        break;
      }
    }
    if (!found) return null;
    if (
      ancestor.attributes.some(
        (a) => !a.conditional && isStatic(a.parts) && (a.name === 'class' || a.name === 'id'),
      )
    ) {
      points += 1;
    }
  }
  return Math.min(points, 2);
}

export interface ElementCandidate {
  readonly span: ElementSpan;
  /** Points of static evidence that agreed; 0 means only the tag did. */
  readonly points: number;
  readonly reasons: readonly string[];
}

export interface ElementSearch {
  /** Source elements that can have produced the rendered one. */
  readonly matched: readonly ElementCandidate[];
  /** Elements that agree on tag, attributes and text but sit under other ancestors. */
  readonly elsewhere: readonly ElementCandidate[];
}

/**
 * Searches `files` for the elements that can have produced `rendered`. With `resolve`, plain
 * setting lookups in attribute values must print the value the theme's JSON holds.
 */
export function searchElements(
  index: ThemeIndex,
  files: readonly string[],
  rendered: RenderedElement,
  resolve?: Resolver,
): ElementSearch {
  const matched: ElementCandidate[] = [];
  const elsewhere: ElementCandidate[] = [];
  const text = collapseSpace(rendered.text);
  for (const path of files) {
    for (const source of sourceElements(index, path)) {
      const own = attributesAgree(source.info, rendered, true, resolve);
      if (!own.ok) continue;
      if (!source.info.text.every((piece) => text.includes(piece))) continue;
      const span: ElementSpan = {
        kind: 'element',
        file: path,
        start: source.start,
        tag: source.info.tag ?? rendered.tag,
      };
      const reasons = [...own.reasons];
      let points = own.points;
      if (source.info.text.length > 0) {
        points += 1;
        reasons.push(`text "${source.info.text.join(' ').slice(0, 40)}"`);
      }
      const above = ancestorsAgree(source.ancestors, rendered.ancestors, resolve);
      if (above === null) {
        elsewhere.push({ span, points, reasons });
        continue;
      }
      if (above > 0) reasons.push('ancestors agree');
      matched.push({ span, points: points + above, reasons });
    }
  }
  return { matched, elsewhere };
}
