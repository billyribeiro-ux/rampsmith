// The additive check on page snapshots (ADR-247): a patch may add elements, attributes and text,
// fill a blank attribute and change CSS; anything else is a violation.
import { describe, expect, it } from 'vitest';
import { additiveChanges, type SnapshotNode } from '../src/browser/snapshot.ts';

function node(tag: string, attributes: Record<string, string> = {}, text = ''): SnapshotNode {
  return { tag, attributes, text };
}

const PAGE: SnapshotNode[] = [
  node('html', { lang: '' }),
  node('head'),
  node('style', {}, 'a { color: #999 }'),
  node('body', { class: 'page' }),
  node('a', { href: '/cart', class: 'cart' }),
  node('img', { src: '/a.png', alt: '' }),
  node('p', { style: 'color: #aaa' }, 'Hello'),
  node('input', { type: 'email', name: 'e' }),
];

function without(index: number): SnapshotNode[] {
  return PAGE.filter((_, i) => i !== index);
}

describe('additiveChanges', () => {
  it('accepts a page unchanged', () => {
    expect(additiveChanges(PAGE, PAGE)).toEqual({ violations: [], added: [] });
  });

  it('accepts added elements, added attributes, filled blanks, new ids and CSS rewrites', () => {
    const after = PAGE.map((n): SnapshotNode => {
      switch (n.tag) {
        case 'html':
          return { ...n, attributes: { lang: 'en' } };
        case 'style':
          return { ...n, text: 'a { color: #595959 }' };
        case 'a':
          return { ...n, attributes: { ...n.attributes, 'aria-label': 'Cart' } };
        case 'img':
          return { ...n, attributes: { ...n.attributes, alt: 'A mug' } };
        case 'p':
          return { ...n, attributes: { style: 'color: #555' } };
        case 'input':
          return { ...n, attributes: { ...n.attributes, id: 'e-1' } };
        default:
          return n;
      }
    });
    after.splice(5, 0, node('span', { class: 'visually-hidden' }, 'Cart'));
    after.splice(4, 0, node('a', { class: 'rampsmith-skip-link', href: '#MainContent' }, 'Skip'));
    const result = additiveChanges(PAGE, after);
    expect(result.violations).toEqual([]);
    expect(result.added.map((n) => n.tag)).toEqual(['a', 'span']);
  });

  it('accepts text added to an element, such as a label', () => {
    const after = PAGE.map((n) => (n.tag === 'a' ? { ...n, text: 'Cart' } : n));
    expect(additiveChanges(PAGE, after).violations).toEqual([]);
  });

  it('reports an element that is gone', () => {
    const result = additiveChanges(PAGE, without(4));
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('<a class="cart">');
    expect(result.violations[0]).toContain('is gone');
  });

  it('reports an attribute with a value that changed or was removed', () => {
    const changed = PAGE.map((n) =>
      n.tag === 'a' ? { ...n, attributes: { ...n.attributes, href: '/other' } } : n,
    );
    expect(additiveChanges(PAGE, changed).violations).toEqual([
      expect.stringContaining('href was "/cart", is "/other"'),
    ]);
    const removed = PAGE.map((n) =>
      n.tag === 'input' ? { ...n, attributes: { type: 'email' } } : n,
    );
    expect(additiveChanges(PAGE, removed).violations).toEqual([
      expect.stringContaining('name was "e", is gone'),
    ]);
  });

  it('reports text that was lost or rewritten', () => {
    const after = PAGE.map((n) => (n.tag === 'p' ? { ...n, text: 'Goodbye' } : n));
    expect(additiveChanges(PAGE, after).violations).toEqual([
      expect.stringContaining('its text "Hello" is now "Goodbye"'),
    ]);
  });

  it('reports elements that moved, since order is kept', () => {
    const after = [...PAGE];
    const [a, img] = [after[4], after[5]];
    if (a === undefined || img === undefined) throw new Error('fixture');
    after[4] = img;
    after[5] = a;
    expect(additiveChanges(PAGE, after).violations).toHaveLength(1);
  });

  it('reports content that vanishes, as an unclosed tag in a patch would make it', () => {
    const after = PAGE.slice(0, 6);
    expect(additiveChanges(PAGE, after).violations).toHaveLength(2);
  });
});
