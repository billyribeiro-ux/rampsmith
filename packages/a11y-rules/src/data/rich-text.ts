// The data audit of rich text: product `descriptionHtml`, page bodies and article bodies
// (PLAN §11, "Data audit"). Pure: no browser, no network, no clock except the parse budget.
//
// Every pass over the tree is iterative and linear in the number of nodes, so hostile input
// cannot overflow the stack or take quadratic time once it is parsed (ADR-111).
import { html as parse5Html } from 'parse5';
import { findingBase } from '../rules.ts';
import type { DataFinding, FindingData, Outcome, RuleId } from '../types.ts';
import { hasNonColourDistinction, normalizeColour, parseInlineStyle } from './css.ts';
import { filenamePattern } from './filename.ts';
import {
  DEFAULT_PARSE_LIMITS,
  attr,
  parseRichText,
  renderedChildren,
  type HtmlElement,
  type ParseFailure,
  type ParseLimits,
} from './html.ts';
import { normalizeLinkText, vagueLinkPhrases } from './locale.ts';

export interface RichTextInput {
  /** The resource that owns the field, such as `gid://shopify/Product/1`. */
  readonly resource: string;
  /** The field, such as `descriptionHtml` or `body`. */
  readonly field: string;
  readonly html: string;
}

export interface RichTextOptions {
  /** The shop's locale for this content, such as `en` or `pt-BR`. Defaults to `en`. */
  readonly locale?: string;
  /**
   * The level of the page's own title heading, which the content sits under. Product, page
   * and article templates title the page with an `h1`, so the default is 1.
   */
  readonly baseHeadingLevel?: number;
  readonly limits?: Partial<ParseLimits>;
}

/** A rule that did not run on this input, and why; reported for coverage disclosure. */
export interface SkippedRule {
  readonly ruleId: RuleId;
  readonly reason: 'locale_unsupported';
}

export type RichTextAudit =
  | {
      readonly status: 'audited';
      readonly findings: readonly DataFinding[];
      readonly skippedRules: readonly SkippedRule[];
    }
  | {
      readonly status: 'not_audited';
      readonly reason: ParseFailure;
      readonly findings: readonly DataFinding[];
      readonly skippedRules: readonly SkippedRule[];
    };

// Text inside these elements is never rendered as page text.
const UNRENDERED_TEXT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'title',
  'iframe',
  'noembed',
  'noframes',
]);

// Blocks: the paragraph-level containers that bound "the words around" a run of text, and
// the programmatically determined link context of WCAG 2.2 (same paragraph, list item or
// table cell; other blocks are included so context is never missed).
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'details',
  'div',
  'dt',
  'figcaption',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'legend',
  'li',
  'main',
  'nav',
  'p',
  'pre',
  'section',
  'summary',
  'td',
  'th',
]);

// Elements whose default rendering sets text apart by something other than colour (ADR-113).
const DISTINCT_ELEMENTS = new Set([
  'a',
  'b',
  'big',
  'cite',
  'code',
  'del',
  'dfn',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'strike',
  'strong',
  'sub',
  'sup',
  'tt',
  'u',
  'var',
]);

/** How far a colour run looks up for an element wrapping exactly its text. */
const WRAPPER_LOOKUP = 32;
/** Longest link name collected; vague phrases are a few words. */
const NAME_CAP = 300;
/** Most nodes read when resolving one aria-labelledby reference. */
const LABEL_NODE_BUDGET = 5_000;

interface Rec {
  readonly el: HtmlElement;
  readonly tag: string;
  readonly isHtml: boolean;
  readonly parent: number;
  /** Not hidden from rendering (the `hidden` attribute, display none, visibility hidden). */
  readonly rendered: boolean;
  /** Rendered and not inside `aria-hidden="true"`. */
  readonly exposed: boolean;
  readonly block: number;
  readonly link: number;
  readonly table: number;
  readonly row: number;
  readonly colour: string | null;
  readonly inheritedColour: string | null;
  readonly distinct: boolean;
  textLen: number;
  distinctLen: number;
  name: string;
}

function countNonWhitespace(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    // ASCII whitespace per the HTML spec, plus no-break space.
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d && c !== 0xa0) n += 1;
  }
  return n;
}

function appendCapped(current: string, text: string): string {
  if (current.length >= NAME_CAP) return current;
  return (current + text).slice(0, NAME_CAP);
}

function isHiddenByAttributes(el: HtmlElement, style: ReadonlyMap<string, string>): boolean {
  if (attr(el, 'hidden') !== undefined) return true;
  if (el.tagName === 'input' && attr(el, 'type')?.toLowerCase() === 'hidden') return true;
  const display = style.get('display')?.toLowerCase();
  const visibility = style.get('visibility')?.toLowerCase();
  return display === 'none' || visibility === 'hidden' || visibility === 'collapse';
}

function roleOf(el: HtmlElement): string {
  return (attr(el, 'role') ?? '').trim().toLowerCase().split(/\s+/, 1)[0] ?? '';
}

function headingLevel(rec: Rec): number | null {
  if (!rec.isHtml) return null;
  const match = /^h([1-6])$/.exec(rec.tag);
  if (match?.[1] !== undefined) return Number(match[1]);
  if (roleOf(rec.el) === 'heading') {
    const level = Number.parseInt(attr(rec.el, 'aria-level') ?? '', 10);
    return Number.isInteger(level) && level >= 1 && level <= 9 ? level : 2;
  }
  return null;
}

interface Built {
  readonly recs: readonly Rec[];
  readonly ids: ReadonlyMap<string, number>;
  readonly totalText: number;
}

/** One iterative pre-order pass building element records, then two reverse passes for text. */
function build(root: ParentNodeLike): Built {
  const recs: Rec[] = [];
  const ids = new Map<string, number>();
  let totalText = 0;

  interface Frame {
    readonly node: ChildLike;
    readonly parent: number;
  }
  const stack: Frame[] = [];
  const pushChildren = (children: readonly ChildLike[], parent: number): void => {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push({ node: child, parent });
    }
  };
  pushChildren(renderedChildren(root), -1);

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, parent } = frame;
    const parentRec = parent === -1 ? undefined : recs[parent];

    if (node.nodeName === '#text' && 'value' in node) {
      if (parentRec !== undefined && (!parentRec.rendered || UNRENDERED_TEXT.has(parentRec.tag))) {
        continue;
      }
      const n = countNonWhitespace(node.value);
      if (parentRec === undefined) totalText += n;
      else parentRec.textLen += n;
      if (parentRec?.exposed === true && parentRec.link !== -1) {
        const link = recs[parentRec.link];
        if (link !== undefined) link.name = appendCapped(link.name, node.value);
      }
      continue;
    }
    if (!('tagName' in node)) continue;

    const el = node;
    const isHtml = el.namespaceURI === parse5Html.NS.HTML;
    const tag = el.tagName.toLowerCase();
    const style = parseInlineStyle(attr(el, 'style') ?? '');
    const rendered = (parentRec?.rendered ?? true) && !isHiddenByAttributes(el, style);
    const exposed =
      rendered &&
      (parentRec?.exposed ?? true) &&
      attr(el, 'aria-hidden')?.trim().toLowerCase() !== 'true';
    const index = recs.length;
    const isLink = isHtml && tag === 'a' && attr(el, 'href') !== undefined;
    const colour = isHtml
      ? normalizeColour(style.get('color') ?? (tag === 'font' ? attr(el, 'color') : undefined))
      : null;

    const rec: Rec = {
      el,
      tag,
      isHtml,
      parent,
      rendered,
      exposed,
      block:
        parentRec === undefined
          ? -1
          : parentRec.isHtml && BLOCKS.has(parentRec.tag)
            ? parent
            : parentRec.block,
      link: isLink ? index : (parentRec?.link ?? -1),
      table: parentRec === undefined ? -1 : parentRec.tag === 'table' ? parent : parentRec.table,
      row:
        parentRec === undefined
          ? -1
          : parentRec.tag === 'tr'
            ? parent
            : parentRec.tag === 'table'
              ? -1
              : parentRec.row,
      colour,
      inheritedColour:
        parentRec === undefined ? null : (parentRec.colour ?? parentRec.inheritedColour),
      distinct:
        isHtml &&
        (DISTINCT_ELEMENTS.has(tag) ||
          (tag === 'abbr' && attr(el, 'title') !== undefined) ||
          hasNonColourDistinction(style)),
      textLen: 0,
      distinctLen: 0,
      name: '',
    };
    recs.push(rec);

    const id = attr(el, 'id');
    if (id !== undefined && id !== '' && !ids.has(id)) ids.set(id, index);

    // Names of descendants count toward the enclosing link's name from content.
    if (exposed && rec.link !== -1 && rec.link !== index) {
      const link = recs[rec.link];
      const own = isHtml && (tag === 'img' || tag === 'area') ? attr(el, 'alt') : undefined;
      const label = attr(el, 'aria-label');
      if (link !== undefined) {
        if (own !== undefined) link.name = appendCapped(link.name, ` ${own} `);
        if (label !== undefined) link.name = appendCapped(link.name, ` ${label} `);
      }
    }
    pushChildren(renderedChildren(el), index);
  }

  // Children always follow their parent in pre-order, so a reverse pass aggregates bottom-up.
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const rec = recs[i];
    if (rec === undefined) continue;
    if (rec.parent === -1) totalText += rec.textLen;
    else {
      const parent = recs[rec.parent];
      if (parent !== undefined) parent.textLen += rec.textLen;
    }
  }
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const rec = recs[i];
    if (rec === undefined) continue;
    if (rec.distinct) rec.distinctLen = rec.textLen;
    const parent = rec.parent === -1 ? undefined : recs[rec.parent];
    if (parent !== undefined) parent.distinctLen += rec.distinctLen;
  }
  return { recs, ids, totalText };
}

type ParentNodeLike = Parameters<typeof renderedChildren>[0];
type ChildLike = ReturnType<typeof renderedChildren>[number];

/** Text of the element with id `id`, read with a node budget, for aria-labelledby. */
function textOfId(built: Built, id: string): string {
  const index = built.ids.get(id);
  const rec = index === undefined ? undefined : built.recs[index];
  if (rec === undefined) return '';
  let text = '';
  let budget = LABEL_NODE_BUDGET;
  const stack: ChildLike[] = [...renderedChildren(rec.el)].reverse();
  for (let node = stack.pop(); node !== undefined && budget > 0; node = stack.pop()) {
    budget -= 1;
    if (node.nodeName === '#text' && 'value' in node) text = appendCapped(text, node.value);
    else if ('tagName' in node) {
      if (UNRENDERED_TEXT.has(node.tagName)) continue;
      const children = renderedChildren(node);
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push(child);
      }
    }
    if (text.length >= NAME_CAP) break;
  }
  return text;
}

/** The accessible name of a link: aria-labelledby, aria-label, content, then title. */
function linkName(built: Built, rec: Rec): string {
  const labelledBy = attr(rec.el, 'aria-labelledby');
  if (labelledBy !== undefined) {
    const fromRefs = labelledBy
      .trim()
      .split(/\s+/)
      .slice(0, 10)
      .map((id) => textOfId(built, id))
      .join(' ')
      .trim();
    if (fromRefs !== '') return fromRefs;
  }
  const label = attr(rec.el, 'aria-label')?.trim() ?? '';
  if (label !== '') return label;
  const content = rec.name.trim();
  if (content !== '') return content;
  return attr(rec.el, 'title')?.trim() ?? '';
}

export function auditRichText(input: RichTextInput, options: RichTextOptions = {}): RichTextAudit {
  const phrases = vagueLinkPhrases(options.locale ?? 'en');
  const skippedRules: SkippedRule[] =
    phrases === null ? [{ ruleId: 'rs-rich-text-link-vague', reason: 'locale_unsupported' }] : [];
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, ...options.limits };
  const parsed = parseRichText(input.html, limits);
  if (!parsed.ok) {
    return { status: 'not_audited', reason: parsed.reason, findings: [], skippedRules };
  }

  const built = build(parsed.fragment);
  const { recs } = built;
  const findings: DataFinding[] = [];

  const locate = (index: number): { start: number; end: number; approximate: boolean } => {
    for (let i = index, steps = 0; i !== -1 && steps <= limits.maxDepth; steps += 1) {
      const rec = recs[i];
      if (rec === undefined) break;
      const loc = rec.el.sourceCodeLocation;
      if (loc !== undefined && loc !== null) {
        return { start: loc.startOffset, end: loc.endOffset, approximate: i !== index };
      }
      i = rec.parent;
    }
    return { start: 0, end: input.html.length, approximate: true };
  };

  const report = (ruleId: RuleId, outcome: Outcome, index: number, data?: FindingData): void => {
    const { start, end, approximate } = locate(index);
    const merged: FindingData | undefined = approximate
      ? { ...data, approximateLocation: true }
      : data;
    findings.push({
      ...findingBase(ruleId, outcome),
      location: { resource: input.resource, field: input.field, start, end },
      ...(merged === undefined ? {} : { data: merged }),
    });
  };

  const base = options.baseHeadingLevel;
  let previousLevel =
    base !== undefined && Number.isInteger(base) && base >= 1 && base <= 6 ? base : 1;

  // Tables: rows and cells counted per owning table, so nested tables never mix.
  const tableRows = new Map<number, number>();
  const rowCells = new Map<number, number>();
  const tableHasHeader = new Set<number>();

  recs.forEach((rec, index) => {
    if (!rec.isHtml) return;

    if (rec.exposed) {
      const level = headingLevel(rec);
      if (level !== null) {
        if (level > previousLevel + 1) {
          report('rs-rich-text-heading-skip', 'violation', index, { level, previousLevel });
        }
        previousLevel = level;
      }
    }

    if (rec.exposed && rec.link === index) {
      const name = linkName(built, rec);
      if (name === '') report('rs-rich-text-link-empty', 'violation', index);
      else if (phrases !== null) {
        const text = normalizeLinkText(name);
        if (phrases.has(text)) {
          const block = rec.block === -1 ? undefined : recs[rec.block];
          const contextText = block === undefined ? built.totalText : block.textLen;
          const hasContext = contextText > rec.textLen;
          report('rs-rich-text-link-vague', hasContext ? 'incomplete' : 'violation', index, {
            text,
            hasContext,
          });
        }
      }
    }

    if (rec.exposed && rec.tag === 'img') {
      const role = roleOf(rec.el);
      const alt = attr(rec.el, 'alt');
      if (alt === undefined) {
        const named = ['aria-label', 'aria-labelledby', 'title'].some(
          (name) => (attr(rec.el, name)?.trim() ?? '') !== '',
        );
        if (!named && role !== 'presentation' && role !== 'none') {
          report('rs-rich-text-img-alt-missing', 'violation', index);
        }
      } else {
        const pattern = filenamePattern(alt, attr(rec.el, 'src'));
        if (pattern !== null) {
          report('rs-rich-text-img-alt-filename', 'violation', index, { pattern });
        }
      }
    }

    if (rec.table !== -1) {
      if (rec.tag === 'tr') tableRows.set(rec.table, (tableRows.get(rec.table) ?? 0) + 1);
      const role = roleOf(rec.el);
      if (rec.tag === 'th' || role === 'columnheader' || role === 'rowheader') {
        tableHasHeader.add(rec.table);
      }
      if ((rec.tag === 'td' || rec.tag === 'th') && rec.row !== -1) {
        rowCells.set(rec.row, (rowCells.get(rec.row) ?? 0) + 1);
      }
    }

    if (
      rec.rendered &&
      rec.colour !== null &&
      rec.colour !== rec.inheritedColour &&
      !rec.distinct &&
      !BLOCKS.has(rec.tag) &&
      rec.textLen > 0 &&
      rec.distinctLen < rec.textLen
    ) {
      let wrapped = false;
      for (let i = rec.parent, steps = 0; i !== -1 && steps < WRAPPER_LOOKUP; steps += 1) {
        const up = recs[i];
        if (up?.textLen !== rec.textLen) break;
        if (up.distinct) {
          wrapped = true;
          break;
        }
        i = up.parent;
      }
      const block = rec.block === -1 ? undefined : recs[rec.block];
      const blockText = block === undefined ? built.totalText : block.textLen;
      if (!wrapped && blockText > rec.textLen) {
        report('rs-rich-text-color-only', 'incomplete', index, { colour: rec.colour });
      }
    }
  });

  // Tables are reported after the walk, once their rows and cells are counted.
  const columnsOf = new Map<number, number>();
  recs.forEach((rec, index) => {
    if (rec.tag !== 'tr' || rec.table === -1) return;
    columnsOf.set(rec.table, Math.max(columnsOf.get(rec.table) ?? 0, rowCells.get(index) ?? 0));
  });
  recs.forEach((rec, index) => {
    if (!rec.isHtml || rec.tag !== 'table' || !rec.exposed) return;
    const role = roleOf(rec.el);
    if (role === 'presentation' || role === 'none') return;
    const rows = tableRows.get(index) ?? 0;
    const columns = columnsOf.get(index) ?? 0;
    if (rows >= 2 && columns >= 2 && !tableHasHeader.has(index)) {
      report('rs-rich-text-table-no-headers', 'violation', index, { rows, columns });
    }
  });

  findings.sort(
    (a, b) =>
      a.location.start - b.location.start ||
      b.location.end - a.location.end ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { status: 'audited', findings, skippedRules };
}
