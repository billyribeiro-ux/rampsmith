/**
 * Selector matching without a browser (ADR-245): three-valued answers, specificity, and the
 * state pseudo-classes. Rendered nodes are written by hand; the corpus runner checks the same
 * code against real Chromium output.
 */
import { describe, expect, it } from 'vitest';
import {
  compareSpecificity,
  matchSelector,
  parseSelectors,
  type MatchOptions,
  type Tri,
} from '../src/map/css/selector.ts';
import type { RenderedNode } from '../src/map/types.ts';

function node(
  tag: string,
  attributes: Record<string, string> = {},
  extra: Partial<RenderedNode> = {},
): RenderedNode {
  return { tag, attributes, ...extra };
}

/** Matches the first selector of `text` against `element` with `ancestors` nearest first. */
function match(
  text: string,
  element: RenderedNode,
  ancestors: readonly RenderedNode[] = [],
  options: MatchOptions = {},
): Tri {
  const [selector] = parseSelectors(text);
  if (selector === undefined) throw new Error(`"${text}" did not parse`);
  return matchSelector(selector, element, ancestors, options);
}

describe('parseSelectors', () => {
  it('returns one complex selector per list item with its specificity', () => {
    const list = parseSelectors('a.btn, #main .item:hover::before');
    expect(list.map((s) => s.text)).toEqual(['a.btn', '#main .item:hover::before']);
    expect(list.map((s) => s.specificity)).toEqual([
      [0, 1, 1],
      [1, 2, 1],
    ]);
  });

  it('counts :where as zero, :is and :not as their most specific argument, [attr] as a class', () => {
    expect(parseSelectors(':where(#a, .b) a')[0]?.specificity).toEqual([0, 0, 1]);
    expect(parseSelectors(':is(#a, .b)')[0]?.specificity).toEqual([1, 0, 0]);
    expect(parseSelectors('a:not(.x, .y)')[0]?.specificity).toEqual([0, 1, 1]);
    expect(parseSelectors('input[type="text"]')[0]?.specificity).toEqual([0, 1, 1]);
    expect(parseSelectors('li:first-child')[0]?.specificity).toEqual([0, 1, 1]);
  });

  it('returns an empty list for text that is not a selector', () => {
    expect(parseSelectors('a[')).toEqual([]);
  });
});

describe('compareSpecificity', () => {
  it('compares ids, then classes, then tags', () => {
    expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
    expect(compareSpecificity([0, 0, 1], [0, 0, 2])).toBeLessThan(0);
    expect(compareSpecificity([0, 1, 1], [0, 1, 1])).toBe(0);
  });
});

describe('matchSelector', () => {
  it('matches tag, class, id and the universal selector, and rejects the rest', () => {
    const a = node('a', { class: 'btn btn--primary', id: 'cta' });
    expect(match('a', a)).toBe('yes');
    expect(match('A.btn', a)).toBe('yes');
    expect(match('.btn--primary', a)).toBe('yes');
    expect(match('#cta', a)).toBe('yes');
    expect(match('*', a)).toBe('yes');
    expect(match('button', a)).toBe('no');
    expect(match('.btn--secondary', a)).toBe('no');
    expect(match('#other', a)).toBe('no');
  });

  it('applies every attribute operator', () => {
    const a = node('a', { href: '/pages/contact-us', lang: 'en-GB', rel: 'noopener external' });
    expect(match('[href]', a)).toBe('yes');
    expect(match('[title]', a)).toBe('no');
    expect(match('[href="/pages/contact-us"]', a)).toBe('yes');
    expect(match('[href="/x"]', a)).toBe('no');
    expect(match('[rel~="external"]', a)).toBe('yes');
    expect(match('[rel~="ext"]', a)).toBe('no');
    expect(match('[lang|="en"]', a)).toBe('yes');
    expect(match('[lang|="fr"]', a)).toBe('no');
    expect(match('[href^="/pages"]', a)).toBe('yes');
    expect(match('[href^=""]', a)).toBe('no');
    expect(match('[href$="us"]', a)).toBe('yes');
    expect(match('[href*="contact"]', a)).toBe('yes');
    expect(match('[href*="nope"]', a)).toBe('no');
    expect(match('[href="/PAGES/CONTACT-US" i]', a)).toBe('yes');
  });

  it('follows descendant and child combinators through the ancestors', () => {
    const li = node('li', { class: 'item' });
    const ul = node('ul', { class: 'list' });
    const nav = node('nav', { id: 'site' });
    const body = node('body');
    const chain = [ul, nav, body];
    expect(match('nav li', li, chain)).toBe('yes');
    expect(match('nav > li', li, chain)).toBe('no');
    expect(match('ul > li', li, chain)).toBe('yes');
    expect(match('#site .list > .item', li, chain)).toBe('yes');
    expect(match('footer li', li, chain)).toBe('no');
    expect(match('ul > li', li, [])).toBe('no');
  });

  it('follows sibling combinators when the siblings were recorded and doubts them when not', () => {
    const h2 = node('h2', {});
    // Nearest first: the span is right before the paragraph, the heading before the span.
    const p = node('p', {}, { previous: [node('span'), h2] });
    expect(match('h2 ~ p', p)).toBe('yes');
    expect(match('h2 + p', p)).toBe('no');
    expect(match('span + p', p)).toBe('yes');
    const unknown = node('p', {});
    expect(match('h2 + p', unknown)).toBe('maybe');
  });

  it('answers structural pseudo-classes from the recorded siblings, else maybe', () => {
    const first = node('li', {}, { previous: [], following: 2 });
    const middle = node('li', {}, { previous: [node('li')], following: 1 });
    const last = node('li', {}, { previous: [node('li'), node('li')], following: 0 });
    const only = node('li', {}, { previous: [], following: 0 });
    expect(match('li:first-child', first)).toBe('yes');
    expect(match('li:first-child', middle)).toBe('no');
    expect(match('li:last-child', last)).toBe('yes');
    expect(match('li:last-child', middle)).toBe('no');
    expect(match('li:only-child', only)).toBe('yes');
    expect(match('li:only-child', first)).toBe('no');
    expect(match('li:nth-child(2)', middle)).toBe('yes');
    expect(match('li:nth-child(odd)', first)).toBe('yes');
    expect(match('li:nth-child(even)', first)).toBe('no');
    expect(match('li:nth-child(2n+1)', last)).toBe('yes');
    expect(match('li:nth-child(-n+2)', last)).toBe('no');
    expect(match('li:nth-last-child(1)', last)).toBe('yes');
    expect(match('li:first-of-type', first)).toBe('yes');
    expect(match('li:first-of-type', middle)).toBe('no');
    const unknown = node('li');
    expect(match('li:first-child', unknown)).toBe('maybe');
    expect(match('li:last-child', unknown)).toBe('maybe');
    expect(match('li:only-child', unknown)).toBe('maybe');
    expect(match('li:nth-child(2)', unknown)).toBe('maybe');
    expect(match('li:nth-last-child(2)', unknown)).toBe('maybe');
    expect(match('li:first-of-type', unknown)).toBe('maybe');
    expect(match('li:nth-child(foo)', middle)).toBe('maybe');
  });

  it('keeps state pseudo-classes off at rest and on for a focus finding', () => {
    const a = node('a', { href: '/' });
    for (const state of [':hover', ':active', ':focus', ':focus-visible', ':focus-within']) {
      expect(match(`a${state}`, a), state).toBe('no');
    }
    expect(match('a:focus', a, [], { focus: true })).toBe('yes');
    expect(match('a:focus-visible', a, [], { focus: true })).toBe('yes');
    expect(match('a:hover', a, [], { focus: true })).toBe('no');
    expect(match('a:not(:focus)', a)).toBe('yes');
    expect(match('a:not(:focus)', a, [], { focus: true })).toBe('no');
  });

  it('answers element-state pseudo-classes from attributes', () => {
    const link = node('a', { href: '/' });
    const bare = node('a');
    const button = node('button', { disabled: '' });
    const input = node('input', { required: '' });
    expect(match(':link', link)).toBe('yes');
    expect(match(':any-link', bare)).toBe('no');
    expect(match(':disabled', button)).toBe('yes');
    expect(match(':enabled', button)).toBe('no');
    expect(match(':enabled', bare)).toBe('yes');
    expect(match(':required', input)).toBe('yes');
    expect(match(':required', bare)).toBe('no');
    expect(match(':checked', node('input', { checked: '' }))).toBe('yes');
    expect(match(':checked', node('input'))).toBe('maybe');
    expect(match(':root', node('html'))).toBe('yes');
    expect(match(':root', node('html'), [node('div')])).toBe('no');
  });

  it('combines :is, :where and :not, and never matches a pseudo-element', () => {
    const a = node('a', { class: 'x' });
    expect(match(':is(a, b)', a)).toBe('yes');
    expect(match(':where(b, i)', a)).toBe('no');
    expect(match('a:not(.y)', a)).toBe('yes');
    expect(match('a:not(.x)', a)).toBe('no');
    expect(match('a::before', a)).toBe('no');
    expect(match('a:after', a)).toBe('no');
  });

  it('returns maybe for a pseudo-class it cannot decide, such as :has()', () => {
    expect(match('a:has(img)', node('a'))).toBe('maybe');
    expect(match('a:future-thing', node('a'))).toBe('maybe');
  });
});
