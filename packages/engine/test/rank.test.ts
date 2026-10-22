import { describe, expect, it } from 'vitest';
import { fixabilityOf, rank, scoreOf, type Rankable } from '../src/pipeline/rank.ts';

const finding = (id: string, over: Partial<Rankable> = {}): Rankable => ({
  id,
  ruleId: 'image-alt',
  impact: 'critical',
  pageTypes: ['home'],
  templates: 1,
  origin: 'render',
  onPurchasePath: false,
  ...over,
});

describe('scoreOf (PLAN §11)', () => {
  it('is impact weight × templates affected × 2 on a purchase path', () => {
    expect(scoreOf('critical', 1, false)).toBe(8);
    expect(scoreOf('serious', 3, false)).toBe(12);
    expect(scoreOf('moderate', 2, true)).toBe(8);
    expect(scoreOf('minor', 5, true)).toBe(10);
  });

  it('counts at least one template', () => {
    expect(scoreOf('serious', 0, false)).toBe(4);
  });
});

describe('rank', () => {
  it('orders by score, best first', () => {
    const ranked = rank([
      finding('a', { impact: 'minor' }),
      finding('b', { impact: 'critical', pageTypes: ['home', 'collection', 'page'], templates: 3 }),
      finding('c', { impact: 'serious' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((r) => r.score)).toEqual([24, 4, 1]);
  });

  it('doubles a finding on the purchase path, however it was marked', () => {
    const [onCart] = rank([finding('a', { pageTypes: ['cart'] })]);
    expect(onCart).toMatchObject({ score: 16, onPurchasePath: true, templatesAffected: 1 });
    const [data] = rank([finding('b', { origin: 'data', pageTypes: [], onPurchasePath: true })]);
    expect(data).toMatchObject({ score: 16, onPurchasePath: true });
  });

  it('breaks ties on how common the failure is, then on how easily it is fixed', () => {
    const ranked = rank([
      finding('x', { ruleId: 'button-name', impact: 'serious' }),
      finding('y', { ruleId: 'color-contrast', impact: 'serious' }),
      finding('z', {
        ruleId: 'rs-media-alt-empty',
        impact: 'serious',
        origin: 'data',
        pageTypes: [],
      }),
      finding('w', { ruleId: 'rs-keyboard-trap', impact: 'serious' }),
    ]);
    // Contrast (83.9%) before buttons (30.6%); then the rules WebAIM has no figure for: the data
    // fix before the one nobody can automate.
    expect(ranked.map((r) => r.id)).toEqual(['y', 'x', 'z', 'w']);
  });

  it('is a total, stable order: the same findings in any order rank the same', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => finding(id));
    expect(rank([...list].reverse()).map((r) => r.id)).toEqual(rank(list).map((r) => r.id));
  });

  it('ranks nothing as nothing', () => {
    expect(rank([])).toEqual([]);
  });
});

describe('fixabilityOf marks a data fix, a code recipe or neither', () => {
  it.each([
    ['rs-media-alt-empty', 'data', 'data', 'media-alt'],
    ['rs-menu-item-label-empty', 'data', 'data', 'menu-label'],
    ['rs-rich-text-link-vague', 'data', 'data', 'rich-text'],
    ['image-alt', 'render', 'code', 'image-alt'],
    ['color-contrast', 'render', 'code', 'contrast'],
    ['label', 'render', 'code', 'form-label'],
    ['link-name', 'render', 'code', 'empty-link'],
    ['button-name', 'render', 'code', 'empty-button'],
    ['html-has-lang', 'render', 'code', 'document-language'],
    ['rs-focus-indicator-missing', 'render', 'code', 'focus-visible'],
    ['rs-keyboard-trap', 'render', 'manual', null],
    ['aria-valid-attr-value', 'render', 'manual', null],
  ] as const)('%s (%s) is %s', (ruleId, origin, kind, recipe) => {
    expect(fixabilityOf(ruleId, origin)).toEqual({ kind, recipe });
  });
});
