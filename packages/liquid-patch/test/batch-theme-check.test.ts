/**
 * What the batch planner does when Theme Check reports an offense the fixes add (ADR-295): the
 * fix that adds it is dropped and accounted for, and the rest are kept. Theme Check itself is
 * covered in `theme-check.test.ts`; here its verdict is decided by the test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchFinding } from '../src/batch.ts';
import { node, pageAbove, rendered, tarn } from './tarn.ts';

const verdict = vi.hoisted(() => vi.fn());

vi.mock('../src/theme-check.ts', () => ({ validateNoNewOffenses: verdict }));

const { planBatch } = await import('../src/batch.ts');

const OK = { ok: true, newOffenses: [] };
const bad = (check: string) => ({
  ok: false,
  newOffenses: [{ file: 'layout/theme.liquid', check, message: 'm', severity: 'error', start: 0 }],
});

const LANG: BatchFinding = {
  id: 'f-lang',
  rule: 'html-has-lang',
  template: 'index',
  nodes: [{ element: rendered('html', {}, '', []) }],
};

const CART: BatchFinding = {
  id: 'f-cart',
  rule: 'link-name',
  template: 'index',
  nodes: [
    {
      element: rendered('a', { href: '/cart', class: 'cart-link' }, '', [
        node('nav', { class: 'site-nav desktop-only' }),
        node('header', { class: 'site-header' }),
        ...pageAbove('sections--2__header'),
      ]),
    },
  ],
  params: { label: { key: 'accessibility.cart', text: 'Cart' } },
};

function theme(): Map<string, string> {
  const files = tarn();
  files.set('locales/en.default.json', '{\n  "general": {\n    "ok": "OK"\n  }\n}\n');
  return files;
}

describe('planBatch with Theme Check offenses', () => {
  beforeEach(() => {
    verdict.mockReset();
  });

  it('drops the fix that adds an offense and keeps the rest', async () => {
    verdict.mockImplementation((_before: unknown, after: Map<string, string>) =>
      Promise.resolve(
        after.get('layout/theme.liquid')?.includes('<html lang') === true
          ? bad('ParserBlockingScript')
          : OK,
      ),
    );
    const plan = await planBatch(theme(), [LANG, CART], { contrast: false });
    expect(plan.steps.map((s) => s.fix.rule)).toEqual(['link-name']);
    expect(plan.skipped).toEqual([
      { findingId: 'f-lang', code: 'theme-check', detail: 'ParserBlockingScript' },
    ]);
    expect(plan.final.get('layout/theme.liquid')).not.toContain('<html lang');
  });

  it('drops them all when each is fine alone but they add an offense together', async () => {
    let calls = 0;
    verdict.mockImplementation(() => {
      calls += 1;
      // The whole batch, then each alone (two), then the survivors together.
      return Promise.resolve(calls === 1 || calls === 4 ? bad('Together') : OK);
    });
    const files = theme();
    const plan = await planBatch(files, [LANG, CART], { contrast: false });
    expect(plan.steps).toEqual([]);
    expect(plan.skipped.map((s) => [s.findingId, s.code]).sort()).toEqual([
      ['f-cart', 'theme-check'],
      ['f-lang', 'theme-check'],
    ]);
    expect([...plan.final.entries()]).toEqual([...files.entries()]);
  });
});
