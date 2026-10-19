/**
 * Matching a CSS selector against a rendered element, without a browser (ADR-245).
 *
 * The answer is three-valued: a selector can match (`yes`), cannot (`no`), or depend on
 * something the scanner did not record (`maybe`: a structural pseudo-class on an ancestor,
 * `:has()`, `&`). The cascade treats `maybe` as a doubt about the answer, never as a match.
 * State pseudo-classes follow the state asked about: at rest, `:hover`, `:active` and `:focus`
 * do not match; for a focus finding, `:focus`, `:focus-visible` and `:focus-within` do.
 */
import selectorParser from 'postcss-selector-parser';
import type { RenderedNode, Sibling } from '../types.ts';

export type Tri = 'yes' | 'no' | 'maybe';

export interface MatchOptions {
  /** Match as if the element has keyboard focus. */
  readonly focus?: boolean;
}

/** (ids, classes and attributes and pseudo-classes, tags and pseudo-elements) */
export type Specificity = readonly [number, number, number];

interface Compound {
  readonly nodes: readonly selectorParser.Node[];
}

export interface ComplexSelector {
  /** The selector as written, whitespace collapsed. */
  readonly text: string;
  readonly compounds: readonly Compound[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`: `' '`, `>`, `+` or `~`. */
  readonly combinators: readonly string[];
  readonly specificity: Specificity;
}

function and(a: Tri, b: Tri): Tri {
  if (a === 'no' || b === 'no') return 'no';
  return a === 'maybe' || b === 'maybe' ? 'maybe' : 'yes';
}

function or(a: Tri, b: Tri): Tri {
  if (a === 'yes' || b === 'yes') return 'yes';
  return a === 'maybe' || b === 'maybe' ? 'maybe' : 'no';
}

function not(a: Tri): Tri {
  if (a === 'maybe') return 'maybe';
  return a === 'yes' ? 'no' : 'yes';
}

function split(selector: selectorParser.Selector): {
  compounds: Compound[];
  combinators: string[];
} {
  const compounds: Compound[] = [];
  const combinators: string[] = [];
  let current: selectorParser.Node[] = [];
  for (const node of selector.nodes) {
    if (selectorParser.isComment(node)) continue;
    if (selectorParser.isCombinator(node)) {
      compounds.push({ nodes: current });
      combinators.push(node.value.trim() === '' ? ' ' : node.value.trim());
      current = [];
    } else {
      current.push(node);
    }
  }
  compounds.push({ nodes: current });
  return { compounds, combinators };
}

const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
  ':before',
  ':after',
  ':first-line',
  ':first-letter',
]);

/** Positive when `a` is more specific than `b`. */
export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function addSpecificity(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function maxSpecificity(list: readonly Specificity[]): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const s of list) if (compareSpecificity(s, best) > 0) best = s;
  return best;
}

function nodeSpecificity(node: selectorParser.Node): Specificity {
  if (selectorParser.isIdentifier(node)) return [1, 0, 0];
  if (selectorParser.isClassName(node) || selectorParser.isAttribute(node)) return [0, 1, 0];
  if (selectorParser.isTag(node)) return [0, 0, 1];
  if (selectorParser.isPseudo(node)) {
    const name = node.value.toLowerCase();
    if (name.startsWith('::') || PSEUDO_ELEMENTS.has(name)) return [0, 0, 1];
    if (name === ':where') return [0, 0, 0];
    if (name === ':not' || name === ':is' || name === ':matches' || name === ':has') {
      return maxSpecificity(node.nodes.map((s) => selectorSpecificity(s)));
    }
    return [0, 1, 0];
  }
  return [0, 0, 0];
}

function selectorSpecificity(selector: selectorParser.Node): Specificity {
  if (!selectorParser.isSelector(selector)) return [0, 0, 0];
  return selector.nodes.reduce<Specificity>(
    (sum, n) => addSpecificity(sum, nodeSpecificity(n)),
    [0, 0, 0],
  );
}

/** The complex selectors of a selector list; empty when the text does not parse. */
export function parseSelectors(text: string): ComplexSelector[] {
  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(text);
  } catch {
    return [];
  }
  return root.nodes.map((selector) => ({
    text: selector.toString().replace(/\s+/gu, ' ').trim(),
    ...split(selector),
    specificity: selectorSpecificity(selector),
  }));
}

/** A node being matched, with what is known on its left and above. */
interface Frame {
  readonly node: Sibling & { readonly following?: number };
  /** Preceding element siblings, nearest first; `undefined` when not collected. */
  readonly previous: readonly Sibling[] | undefined;
  readonly ancestors: readonly RenderedNode[];
}

function frameOf(node: RenderedNode, ancestors: readonly RenderedNode[]): Frame {
  return { node, previous: node.previous, ancestors };
}

function parentFrame(frame: Frame): Frame | null {
  const [parent, ...rest] = frame.ancestors;
  return parent === undefined ? null : frameOf(parent, rest);
}

function classes(node: Sibling): string[] {
  return (node.attributes['class'] ?? '').split(/\s+/u).filter((c) => c !== '');
}

function attributeMatches(node: Sibling, attr: selectorParser.Attribute): Tri {
  const actual = node.attributes[attr.attribute.toLowerCase()];
  if (actual === undefined) return 'no';
  if (attr.operator === undefined) return 'yes';
  const insensitive = attr.insensitive === true;
  const a = insensitive ? actual.toLowerCase() : actual;
  const v = insensitive ? (attr.value ?? '').toLowerCase() : (attr.value ?? '');
  switch (attr.operator) {
    case '=':
      return a === v ? 'yes' : 'no';
    case '~=':
      return a.split(/\s+/u).includes(v) ? 'yes' : 'no';
    case '|=':
      return a === v || a.startsWith(`${v}-`) ? 'yes' : 'no';
    case '^=':
      return v !== '' && a.startsWith(v) ? 'yes' : 'no';
    case '$=':
      return v !== '' && a.endsWith(v) ? 'yes' : 'no';
    case '*=':
      return v !== '' && a.includes(v) ? 'yes' : 'no';
    default:
      return 'maybe';
  }
}

/** `an+b` or `odd`/`even`/`n`; `null` when it is not understood. */
function parseNth(text: string): { a: number; b: number } | null {
  const t = text.replace(/\s+/gu, '').toLowerCase();
  if (t === 'odd') return { a: 2, b: 1 };
  if (t === 'even') return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/u.exec(t);
  if (m !== null) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return { a, b: Number(m[2] ?? 0) };
  }
  return /^[+-]?\d+$/u.test(t) ? { a: 0, b: Number(t) } : null;
}

function nthMatches(position: number, nth: { a: number; b: number }): boolean {
  if (nth.a === 0) return position === nth.b;
  const n = (position - nth.b) / nth.a;
  return Number.isInteger(n) && n >= 0;
}

const FOCUS_STATES: ReadonlySet<string> = new Set([':focus', ':focus-visible', ':focus-within']);
const RESTING_NO: ReadonlySet<string> = new Set([
  ':hover',
  ':active',
  ':visited',
  ':target',
  ':focus',
  ':focus-visible',
  ':focus-within',
  ':fullscreen',
  ':popover-open',
  ':open',
]);

function pseudoMatches(frame: Frame, pseudo: selectorParser.Pseudo, options: MatchOptions): Tri {
  const name = pseudo.value.toLowerCase();
  if (name.startsWith('::') || PSEUDO_ELEMENTS.has(name)) return 'no';
  const { node } = frame;
  const args = pseudo.nodes;
  switch (name) {
    case ':not':
      return not(args.reduce<Tri>((sum, s) => or(sum, selectorList(s, frame, options)), 'no'));
    case ':is':
    case ':where':
    case ':matches':
    case ':any':
      return args.reduce<Tri>((sum, s) => or(sum, selectorList(s, frame, options)), 'no');
    case ':root':
      return node.tag === 'html' && frame.ancestors.length === 0 ? 'yes' : 'no';
    case ':first-child':
      return frame.previous === undefined ? 'maybe' : frame.previous.length === 0 ? 'yes' : 'no';
    case ':last-child':
      return node.following === undefined ? 'maybe' : node.following === 0 ? 'yes' : 'no';
    case ':only-child':
      if (frame.previous === undefined || node.following === undefined) return 'maybe';
      return frame.previous.length === 0 && node.following === 0 ? 'yes' : 'no';
    case ':nth-child':
    case ':nth-last-child': {
      const nth = parseNth(pseudo.nodes.map((s) => s.toString()).join(','));
      if (nth === null) return 'maybe';
      if (name === ':nth-child') {
        return frame.previous === undefined
          ? 'maybe'
          : nthMatches(frame.previous.length + 1, nth)
            ? 'yes'
            : 'no';
      }
      return node.following === undefined
        ? 'maybe'
        : nthMatches(node.following + 1, nth)
          ? 'yes'
          : 'no';
    }
    case ':first-of-type':
      return frame.previous === undefined
        ? 'maybe'
        : frame.previous.some((s) => s.tag === node.tag)
          ? 'no'
          : 'yes';
    case ':link':
    case ':any-link':
      return (node.tag === 'a' || node.tag === 'area') && node.attributes['href'] !== undefined
        ? 'yes'
        : 'no';
    case ':disabled':
      return node.attributes['disabled'] !== undefined ? 'yes' : 'no';
    case ':enabled':
      return node.attributes['disabled'] !== undefined ? 'no' : 'yes';
    case ':checked':
      return node.attributes['checked'] !== undefined ? 'yes' : 'maybe';
    case ':required':
      return node.attributes['required'] !== undefined ? 'yes' : 'no';
    default:
      break;
  }
  if (options.focus === true && FOCUS_STATES.has(name)) return 'yes';
  if (RESTING_NO.has(name)) return 'no';
  return 'maybe';
}

function simpleMatches(frame: Frame, node: selectorParser.Node, options: MatchOptions): Tri {
  if (selectorParser.isUniversal(node)) return 'yes';
  if (selectorParser.isTag(node)) return frame.node.tag === node.value.toLowerCase() ? 'yes' : 'no';
  if (selectorParser.isClassName(node))
    return classes(frame.node).includes(node.value) ? 'yes' : 'no';
  if (selectorParser.isIdentifier(node))
    return frame.node.attributes['id'] === node.value ? 'yes' : 'no';
  if (selectorParser.isAttribute(node)) return attributeMatches(frame.node, node);
  if (selectorParser.isPseudo(node)) return pseudoMatches(frame, node, options);
  return 'maybe';
}

function compoundMatches(frame: Frame, compound: Compound, options: MatchOptions): Tri {
  let result: Tri = 'yes';
  for (const node of compound.nodes) {
    result = and(result, simpleMatches(frame, node, options));
    if (result === 'no') return 'no';
  }
  return result;
}

/** An argument of `:not()` or `:is()`: a selector (list) matched at the same node. */
function selectorList(selector: selectorParser.Node, frame: Frame, options: MatchOptions): Tri {
  if (!selectorParser.isSelector(selector)) return 'maybe';
  const { compounds, combinators } = split(selector);
  return matchFrom({ compounds, combinators }, compounds.length - 1, frame, options);
}

function matchFrom(
  selector: { compounds: readonly Compound[]; combinators: readonly string[] },
  i: number,
  frame: Frame,
  options: MatchOptions,
): Tri {
  const compound = selector.compounds[i];
  if (compound === undefined) return 'maybe';
  const here = compoundMatches(frame, compound, options);
  if (here === 'no' || i === 0) return here;
  const combinator = selector.combinators[i - 1];
  let rest: Tri = 'no';
  if (combinator === '>') {
    const parent = parentFrame(frame);
    rest = parent === null ? 'no' : matchFrom(selector, i - 1, parent, options);
  } else if (combinator === ' ') {
    let parent = parentFrame(frame);
    while (parent !== null && rest !== 'yes') {
      rest = or(rest, matchFrom(selector, i - 1, parent, options));
      parent = parentFrame(parent);
    }
  } else if (combinator === '+' || combinator === '~') {
    const previous = frame.previous;
    if (previous === undefined) {
      rest = 'maybe';
    } else {
      const limit = combinator === '+' ? Math.min(1, previous.length) : previous.length;
      for (let j = 0; j < limit && rest !== 'yes'; j += 1) {
        const sibling = previous[j];
        if (sibling === undefined) break;
        const siblingFrame: Frame = {
          node: sibling,
          previous: previous.slice(j + 1),
          ancestors: frame.ancestors,
        };
        rest = or(rest, matchFrom(selector, i - 1, siblingFrame, options));
      }
    }
  } else {
    rest = 'maybe';
  }
  return and(here, rest);
}

/** Whether `selector` matches the element whose ancestors, nearest first, are given. */
export function matchSelector(
  selector: ComplexSelector,
  element: RenderedNode,
  ancestors: readonly RenderedNode[],
  options: MatchOptions = {},
): Tri {
  return matchFrom(selector, selector.compounds.length - 1, frameOf(element, ancestors), options);
}
