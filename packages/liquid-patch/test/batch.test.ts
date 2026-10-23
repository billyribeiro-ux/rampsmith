/**
 * The batch planner (ADR-295): findings in, an ordered set of fixes out, each commit's file
 * contents cumulative, every finding not fixed accounted for with a code.
 */
import { describe, expect, it } from 'vitest';
import { planBatch, type BatchFinding } from '../src/batch.ts';
import { node, pageAbove, rendered, tarn } from './tarn.ts';

function theme(): Map<string, string> {
  const files = tarn();
  files.set('locales/en.default.json', '{\n  "general": {\n    "ok": "OK"\n  }\n}\n');
  return files;
}

const LANG: BatchFinding = {
  id: 'f-lang',
  rule: 'html-has-lang',
  template: 'index',
  nodes: [{ element: rendered('html', {}, '', []) }],
};

const cart = (cls: string) =>
  rendered('a', { href: '/cart', class: 'cart-link' }, '', [
    node('nav', { class: `site-nav ${cls}` }),
    node('header', { class: 'site-header' }),
    ...pageAbove('sections--2__header'),
  ]);

const CART: BatchFinding = {
  id: 'f-cart',
  rule: 'link-name',
  template: 'index',
  nodes: [{ element: cart('desktop-only') }, { element: cart('mobile-only') }],
  params: { label: { key: 'accessibility.cart', text: 'Cart' } },
};

describe('planBatch', () => {
  it('plans one commit per fix, each on top of the one before', async () => {
    const files = theme();
    const plan = await planBatch(files, [CART, LANG], { contrast: true });
    expect(plan.skipped).toEqual([]);
    expect(plan.steps.map((s) => s.fix.rule)).toEqual(['html-has-lang', 'link-name']);
    expect(plan.steps.map((s) => s.ordinal)).toEqual([1, 2]);
    const layout = plan.steps[0]?.files.find((f) => f.file === 'layout/theme.liquid');
    expect(layout?.before).toBe(files.get('layout/theme.liquid'));
    expect(layout?.after).toMatch(/<html lang="/u);
    const link = plan.steps[1];
    expect(link?.files.map((f) => f.file)).toEqual([
      'locales/en.default.json',
      'sections/header.liquid',
    ]);
    expect(link?.files[0]?.after).toContain('"accessibility"');
    // The same fix reaches the hidden twin of the link (the mapper's `identical`).
    expect(plan.final.get('sections/header.liquid')?.match(/accessibility\.cart/gu)).toHaveLength(
      2,
    );
    expect(plan.final.get('layout/theme.liquid')).toBe(layout?.after);
  });

  it('is deterministic whatever order the findings arrive in', async () => {
    const a = await planBatch(theme(), [CART, LANG], { contrast: true });
    const b = await planBatch(theme(), [LANG, CART], { contrast: true });
    expect(b.steps).toEqual(a.steps);
    expect([...b.final]).toEqual([...a.final]);
  });

  it('says why a finding is not fixed, in codes', async () => {
    const noLabel: BatchFinding = { ...CART, id: 'f-nolabel' };
    delete (noLabel as { params?: unknown }).params;
    const findings: BatchFinding[] = [
      LANG,
      noLabel,
      { id: 'f-size', rule: 'target-size', template: 'index', nodes: [] },
      {
        id: 'f-contrast',
        rule: 'color-contrast',
        template: 'index',
        nodes: [{ element: rendered('p', { class: 'plain' }, 'Plain copy', []) }],
      },
      {
        id: 'f-gone',
        rule: 'button-name',
        template: 'index',
        nodes: [
          {
            element: rendered('button', { class: 'nowhere' }, '', pageAbove('template--1__hero')),
          },
        ],
        params: { label: { key: 'accessibility.go', text: 'Go' } },
      },
    ];
    const plan = await planBatch(theme(), findings, { contrast: false });
    const codes = Object.fromEntries(plan.skipped.map((s) => [s.findingId, s.code]));
    expect(codes).toEqual({
      'f-size': 'no-recipe',
      'f-contrast': 'plan',
      'f-nolabel': 'refused',
      'f-gone': expect.stringMatching(/unmapped|needs-review/u),
    });
    expect(plan.skipped.find((s) => s.findingId === 'f-nolabel')?.detail).toBe('invalid-parameter');
    expect(plan.steps.map((s) => s.fix.findingId)).toEqual(['f-lang']);
  });

  it('skips a fix the theme already has', async () => {
    const files = theme();
    files.set(
      'layout/theme.liquid',
      (files.get('layout/theme.liquid') ?? '').replace('<html>', '<html lang="en">'),
    );
    const plan = await planBatch(files, [LANG], { contrast: true });
    expect(plan.steps).toEqual([]);
    expect(plan.skipped.map((s) => s.code)).toEqual(['already-fixed']);
  });

  it('keeps an unfixable batch untouched', async () => {
    const files = theme();
    const plan = await planBatch(files, [], { contrast: true });
    expect(plan.steps).toEqual([]);
    expect([...plan.final]).toEqual([...files]);
  });

  it('skips a fix whose translation disagrees with an earlier one', async () => {
    const other: BatchFinding = {
      ...CART,
      id: 'f-cart-2',
      params: { label: { key: 'accessibility.cart', text: 'Basket' } },
    };
    const plan = await planBatch(theme(), [CART, other], { contrast: true });
    expect(plan.steps.map((s) => s.fix.findingId)).toEqual(['f-cart']);
    expect(plan.skipped).toEqual([
      { findingId: 'f-cart-2', code: 'conflict', detail: 'translation accessibility.cart' },
    ]);
  });
});
