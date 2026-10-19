/**
 * Headings and links in a product description or page body (`descriptionHtml`, page `body`),
 * and the span edits that change them (PLAN §11 data audit, §12 "Skipped headings, vague link
 * text"). The model never writes HTML: it returns heading levels and plain link text, and
 * this module edits only those spans of the merchant's original markup, escaping the text, so
 * the rest of the HTML stays byte-for-byte identical (the same rule as ADR-007's span
 * patches).
 */
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

interface Span {
  readonly start: number;
  readonly end: number;
}

export interface HeadingTarget {
  readonly index: number;
  readonly level: number;
  readonly text: string;
  readonly startTag: Span;
  readonly endTag: Span | null;
}

export interface LinkTarget {
  readonly index: number;
  /** The accessible name as a screen reader would compute it, roughly. */
  readonly name: string;
  readonly href: string;
  /** Text of the nearest block around the link. */
  readonly context: string;
  /** True when the link holds elements other than inline text formatting. */
  readonly hasElementChildren: boolean;
  readonly startTag: Span;
  readonly endTag: Span | null;
  readonly ariaLabel: Span | null;
}

export interface DescriptionAnalysis {
  readonly headings: readonly HeadingTarget[];
  readonly links: readonly LinkTarget[];
  /** Indexes of headings whose level is above the base or skips a level. */
  readonly headingIssues: readonly number[];
  /** Indexes of links whose name is empty or meaningless out of context (2.4.4). */
  readonly linkIssues: readonly number[];
}

/** English phrases that name no destination (WCAG 2.4.4; WebAIM's "click here" class). */
const VAGUE = new Set([
  '',
  'click',
  'click here',
  'here',
  'link',
  'this link',
  'this',
  'more',
  'read more',
  'learn more',
  'more info',
  'more information',
  'details',
  'see more',
  'go',
  'continue',
  'click this',
  'view',
  'view more',
  'info',
]);

const INLINE = new Set([
  'b',
  'strong',
  'i',
  'em',
  'span',
  'u',
  'small',
  'mark',
  'abbr',
  'bdi',
  'bdo',
  'cite',
  'code',
  'q',
  's',
  'sub',
  'sup',
  'time',
  'br',
  'wbr',
]);
const BLOCK = new Set([
  'p',
  'li',
  'td',
  'th',
  'dd',
  'dt',
  'div',
  'section',
  'article',
  'blockquote',
  'figcaption',
  'caption',
]);

function isElement(node: Node | DefaultTreeAdapterTypes.ParentNode): node is Element {
  return 'tagName' in node;
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Thrown when a fragment is too deep or has too many headings or links to rewrite. */
export class HtmlLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HtmlLimitError';
  }
}

/** Bounds that keep analysis linear in the size of the HTML (security audit HIGH-2). */
export const HTML_LIMITS = {
  maxDepth: 256,
  maxHeadings: 100,
  maxLinks: 200,
  /** Characters of heading text, link names and link context kept per item. */
  maxItemText: 300,
} as const;

/**
 * Text content with image alt text, collapsed. Iterative, so depth cannot overflow the stack;
 * stops collecting once `max` characters are certain.
 */
function textOf(roots: readonly Node[], max: number = Number.POSITIVE_INFINITY): string {
  let out = '';
  const stack: Node[] = [...roots].reverse();
  while (stack.length > 0 && out.length <= max * 4 + 64) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.nodeName === '#text') {
      out += (node as DefaultTreeAdapterTypes.TextNode).value;
    } else if (isElement(node)) {
      if (node.tagName === 'img') {
        out += ` ${node.attrs.find((a) => a.name === 'alt')?.value ?? ''} `;
      } else if (node.tagName === 'br') {
        out += ' ';
      } else if (node.tagName !== 'template') {
        for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
          const child = node.childNodes[i];
          if (child !== undefined) {
            stack.push(child);
          }
        }
      }
    }
  }
  const text = collapse(out);
  return text.length > max ? text.slice(0, max) : text;
}

function childrenText(element: Element, max: number): string {
  return textOf(element.childNodes, max);
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** Accessible name, simplified: `aria-label`, else text content with image alt text. */
function linkName(element: Element): string {
  const label = attr(element, 'aria-label');
  if (label !== undefined && collapse(label) !== '') {
    return collapse(label).slice(0, HTML_LIMITS.maxItemText);
  }
  return childrenText(element, HTML_LIMITS.maxItemText);
}

function hasNonInlineChildren(element: Element): boolean {
  const stack: Node[] = [...element.childNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node !== undefined && isElement(node)) {
      if (!INLINE.has(node.tagName)) {
        return true;
      }
      stack.push(...node.childNodes);
    }
  }
  return false;
}

export function isVagueLinkText(name: string): boolean {
  return VAGUE.has(
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim(),
  );
}

function span(location: { startOffset: number; endOffset: number } | undefined): Span | null {
  return location === undefined ? null : { start: location.startOffset, end: location.endOffset };
}

/**
 * Lists the headings and links of an HTML fragment with their source spans and issues. Throws
 * `HtmlLimitError` past `HTML_LIMITS`, before doing work that grows with them.
 */
export function analyzeDescription(html: string, baseLevel = 2): DescriptionAnalysis {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const headings: HeadingTarget[] = [];
  const links: LinkTarget[] = [];
  const blockText = new Map<Element, string>();
  const contextOf = (block: Element | null): string => {
    if (block === null) {
      return '';
    }
    let text = blockText.get(block);
    if (text === undefined) {
      text = childrenText(block, HTML_LIMITS.maxItemText);
      blockText.set(block, text);
    }
    return text;
  };
  const stack: { node: Node; block: Element | null; depth: number }[] = [...fragment.childNodes]
    .reverse()
    .map((node) => ({ node, block: null, depth: 1 }));
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      break;
    }
    const { node, block, depth } = item;
    if (!isElement(node)) {
      continue;
    }
    if (depth > HTML_LIMITS.maxDepth) {
      throw new HtmlLimitError('the HTML is nested too deeply');
    }
    const nearest = BLOCK.has(node.tagName) ? node : block;
    const location = node.sourceCodeLocation;
    const heading = /^h([1-6])$/u.exec(node.tagName);
    if (heading !== null && location?.startTag !== undefined) {
      if (headings.length === HTML_LIMITS.maxHeadings) {
        throw new HtmlLimitError('the HTML has too many headings');
      }
      headings.push({
        index: headings.length,
        level: Number(heading[1]),
        text: childrenText(node, HTML_LIMITS.maxItemText),
        startTag: { start: location.startTag.startOffset, end: location.startTag.endOffset },
        endTag: span(location.endTag),
      });
    }
    if (
      node.tagName === 'a' &&
      attr(node, 'href') !== undefined &&
      location?.startTag !== undefined
    ) {
      if (links.length === HTML_LIMITS.maxLinks) {
        throw new HtmlLimitError('the HTML has too many links');
      }
      links.push({
        index: links.length,
        name: linkName(node),
        href: attr(node, 'href') ?? '',
        context: contextOf(nearest),
        hasElementChildren: hasNonInlineChildren(node),
        startTag: { start: location.startTag.startOffset, end: location.startTag.endOffset },
        endTag: span(location.endTag),
        ariaLabel: span(location.attrs?.['aria-label']),
      });
    }
    if (node.tagName !== 'template') {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
        const child = node.childNodes[i];
        if (child !== undefined) {
          stack.push({ node: child, block: nearest, depth: depth + 1 });
        }
      }
    }
  }
  const headingIssues: number[] = [];
  let previous = baseLevel - 1;
  for (const h of headings) {
    if (h.level < baseLevel || h.level > previous + 1) {
      headingIssues.push(h.index);
    }
    previous = Math.max(h.level, baseLevel);
  }
  const linkIssues = links.filter((l) => isVagueLinkText(l.name)).map((l) => l.index);
  return { headings, links, headingIssues, linkIssues };
}

/** Whether a level sequence starts at the base and never skips a level going deeper. */
export function validHeadingOutline(levels: readonly number[], baseLevel = 2): boolean {
  let previous = baseLevel - 1;
  for (const level of levels) {
    if (!Number.isInteger(level) || level < baseLevel || level > 6 || level > previous + 1) {
      return false;
    }
    previous = level;
  }
  return true;
}

function escapeText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface RewriteChanges {
  /** New level by heading index. */
  readonly headings: ReadonlyMap<number, number>;
  /** New link text by link index. */
  readonly links: ReadonlyMap<number, string>;
}

function tagNameEdit(html: string, at: number, level: number): Edit {
  const name = html.slice(at, at + 2);
  if (!/^h[1-6]$/iu.test(name)) {
    throw new Error('heading tag name not found at its span');
  }
  return { start: at, end: at + 2, replacement: `h${String(level)}` };
}

/**
 * Applies heading-level and link-text changes as span edits, from the end backwards, and
 * re-parses the result to prove that nothing else moved. Throws when a change cannot be made
 * safely (a heading without an end tag, overlapping edits, or a result that parses
 * differently).
 */
export function applyRewrite(
  html: string,
  analysis: DescriptionAnalysis,
  changes: RewriteChanges,
): string {
  const edits: Edit[] = [];
  for (const [index, level] of changes.headings) {
    const h = analysis.headings[index];
    if (h === undefined) {
      throw new Error('no heading with that index');
    }
    if (h.level === level) {
      continue;
    }
    if (h.endTag === null) {
      throw new Error('a heading without an end tag cannot be changed safely');
    }
    edits.push(tagNameEdit(html, h.startTag.start + 1, level));
    edits.push(tagNameEdit(html, h.endTag.start + 2, level));
  }
  for (const [index, text] of changes.links) {
    const link = analysis.links[index];
    if (link === undefined) {
      throw new Error('no link with that index');
    }
    if (!link.hasElementChildren && link.endTag !== null && link.ariaLabel === null) {
      edits.push({
        start: link.startTag.end,
        end: link.endTag.start,
        replacement: escapeText(text),
      });
    } else if (link.ariaLabel !== null) {
      edits.push({
        start: link.ariaLabel.start,
        end: link.ariaLabel.end,
        replacement: `aria-label="${escapeAttribute(text)}"`,
      });
    } else {
      const close = html.slice(link.startTag.start, link.startTag.end).endsWith('/>') ? 2 : 1;
      const at = link.startTag.end - close;
      edits.push({ start: at, end: at, replacement: ` aria-label="${escapeAttribute(text)}"` });
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < edits.length; i += 1) {
    const later = edits[i - 1];
    const earlier = edits[i];
    if (
      later !== undefined &&
      earlier !== undefined &&
      (earlier.end > later.start || earlier.start === later.start)
    ) {
      throw new Error('edits overlap');
    }
  }
  let out = html;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  verify(html, out, analysis, changes);
  return out;
}

function verify(
  before: string,
  after: string,
  analysis: DescriptionAnalysis,
  changes: RewriteChanges,
): void {
  const result = analyzeDescription(after);
  if (
    result.headings.length !== analysis.headings.length ||
    result.links.length !== analysis.links.length
  ) {
    throw new Error('the rewrite changed the number of headings or links');
  }
  result.headings.forEach((h, i) => {
    const expected = changes.headings.get(i) ?? analysis.headings[i]?.level;
    if (h.level !== expected || h.text !== analysis.headings[i]?.text) {
      throw new Error('a heading did not end up as intended');
    }
  });
  result.links.forEach((l, i) => {
    const wanted = changes.links.get(i);
    const expected = wanted === undefined ? analysis.links[i]?.name : collapse(wanted);
    if (l.name !== expected || l.href !== analysis.links[i]?.href) {
      throw new Error('a link did not end up as intended');
    }
  });
  const strip = (html: string, a: DescriptionAnalysis) => {
    // Text outside the changed links must be identical.
    let text = html;
    const spans = a.links
      .filter((l) => changes.links.has(l.index) && l.endTag !== null)
      .map((l) => ({ start: l.startTag.start, end: l.endTag?.end ?? l.startTag.end }))
      .sort((x, y) => y.start - x.start);
    for (const s of spans) {
      text = text.slice(0, s.start) + text.slice(s.end);
    }
    return textOf(parseFragment(text).childNodes);
  };
  if (strip(before, analysis) !== strip(after, result)) {
    throw new Error('the rewrite changed text outside its targets');
  }
}
