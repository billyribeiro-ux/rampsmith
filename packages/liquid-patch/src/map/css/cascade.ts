/**
 * The cascade for one property of one rendered element, from source CSS (ADR-245): which
 * declaration wins, by importance, then inline style, then specificity, then load order.
 *
 * Doubt is tracked, not hidden. A rule whose selector depends on something the scanner did not
 * record, or whose at-rule the viewport did not settle, makes the answer `uncertain` when it
 * could have won; the mapper then lowers its confidence instead of guessing.
 */
import type { RenderedNode } from '../types.ts';
import type { CssDeclaration, CssIndex, CssRule } from './index.ts';
import {
  compareSpecificity,
  matchSelector,
  type MatchOptions,
  type Specificity,
  type Tri,
} from './selector.ts';

interface Candidate {
  readonly declaration: CssDeclaration;
  /** `null` for an inline `style` attribute. */
  readonly rule: CssRule | null;
  readonly specificity: Specificity;
  readonly match: Tri;
}

export interface Cascade {
  readonly winner: Candidate | null;
  /** 0 when the element's own declaration won, n when the nth ancestor's was inherited. */
  readonly level: number;
  readonly uncertain: boolean;
  readonly notes: readonly string[];
}

export interface CascadeOptions {
  /** True for inherited properties such as `color`: look up the ancestors for a winner. */
  readonly inherited: boolean;
  readonly match?: MatchOptions;
  /** Declarations of the element's own `style` attribute, read from the source. */
  readonly inline?: readonly CssDeclaration[];
}

/** Compares cascade priority: positive when `a` beats `b`. */
function priority(a: Candidate, b: Candidate): number {
  if (a.declaration.important !== b.declaration.important) return a.declaration.important ? 1 : -1;
  const aInline = a.rule === null;
  const bInline = b.rule === null;
  if (aInline !== bInline) return aInline ? 1 : -1;
  const bySpecificity = compareSpecificity(a.specificity, b.specificity);
  return bySpecificity !== 0 ? bySpecificity : (a.rule?.order ?? 0) - (b.rule?.order ?? 0);
}

const INHERIT = /^(?:inherit|currentcolor|unset|revert)$/iu;

function candidatesAt(
  css: CssIndex,
  chain: readonly RenderedNode[],
  level: number,
  properties: ReadonlySet<string>,
  options: CascadeOptions,
): Candidate[] {
  const node = chain[level];
  if (node === undefined) return [];
  const ancestors = chain.slice(level + 1);
  const found: Candidate[] = [];
  for (const rule of css.rules) {
    const wanted = rule.declarations.filter((d) => properties.has(d.property));
    if (wanted.length === 0) continue;
    let best: { specificity: Specificity; match: Tri } | null = null;
    for (const selector of rule.selectors) {
      const match = matchSelector(selector, node, ancestors, options.match);
      if (match === 'no') continue;
      const better =
        best === null ||
        (match === 'yes' && best.match !== 'yes') ||
        (match === best.match && compareSpecificity(selector.specificity, best.specificity) > 0);
      if (better) best = { specificity: selector.specificity, match };
    }
    if (best === null) continue;
    const match: Tri = best.match === 'yes' && rule.conditional ? 'maybe' : best.match;
    for (const declaration of wanted) {
      found.push({ declaration, rule, specificity: best.specificity, match });
    }
  }
  const style = node.attributes['style'];
  if (style !== undefined && (level > 0 || options.inline === undefined)) {
    // An inline style the source was not read for might set the property: doubt, not a guess.
    const hit = [...properties].find((p) =>
      new RegExp(`(?:^|;)\\s*${p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:`, 'iu').test(style),
    );
    if (hit !== undefined) {
      found.push({
        declaration: {
          file: '',
          property: hit,
          value: style,
          start: -1,
          end: -1,
          valueStart: -1,
          valueEnd: -1,
          important: false,
        },
        rule: null,
        specificity: [1, 0, 0],
        match: 'maybe',
      });
    }
  }
  if (level === 0) {
    for (const declaration of options.inline ?? []) {
      if (properties.has(declaration.property)) {
        found.push({ declaration, rule: null, specificity: [1, 0, 0], match: 'yes' });
      }
    }
  }
  return found;
}

/**
 * The winning declaration of any of `properties` for `chain[0]`; `chain` is the element
 * followed by its ancestors, nearest first. For an inherited property, an element with no
 * declaration (or one that says `inherit`) takes its parent's.
 */
export function cascade(
  css: CssIndex,
  chain: readonly RenderedNode[],
  properties: readonly string[],
  options: CascadeOptions,
): Cascade {
  const wanted = new Set(properties);
  const notes: string[] = [];
  let uncertain = false;
  const last = options.inherited ? chain.length - 1 : 0;
  for (let level = 0; level <= last; level += 1) {
    const found = candidatesAt(css, chain, level, wanted, options);
    const sure = found.filter((c) => c.match === 'yes');
    const winner = sure.reduce<Candidate | null>(
      (best, c) => (best === null || priority(c, best) > 0 ? c : best),
      null,
    );
    const doubts = found.filter(
      (c) => c.match === 'maybe' && (winner === null || priority(c, winner) > 0),
    );
    if (doubts.length > 0) {
      uncertain = true;
      notes.push(
        `${String(doubts.length)} rule(s) might apply at level ${String(level)}: ${doubts
          .slice(0, 2)
          .map((d) => d.rule?.selectorText ?? 'style attribute')
          .join(', ')}`,
      );
    }
    if (winner === null) continue;
    if (INHERIT.test(winner.declaration.value) && options.inherited) {
      notes.push(`${winner.rule?.selectorText ?? 'style'} says ${winner.declaration.value}`);
      continue;
    }
    return { winner, level, uncertain, notes };
  }
  return { winner: null, level: 0, uncertain, notes };
}
