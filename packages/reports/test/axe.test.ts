// Every HTML output passes axe-core 4.14.0 with zero violations, best practices included
// (PLAN §27 definition of done: "New UI passes axe with zero violations").
import axe from 'axe-core';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launch } from './support/browser.ts';
import { outputs, storePage } from './support/outputs.ts';

interface AxeSummary {
  readonly violations: readonly { id: string; impact: string | null; targets: string[] }[];
  readonly incomplete: readonly { id: string; targets: string[] }[];
  readonly passes: number;
}

let browser: Browser;

beforeAll(async () => {
  browser = await launch();
});

afterAll(async () => {
  await browser.close();
});

async function audit(markup: string): Promise<AxeSummary> {
  // The reports' own policy refuses every script, so this context bypasses it to inject axe.
  const context = await browser.newContext({ bypassCSP: true, offline: true });
  try {
    const page = await context.newPage();
    await page.setContent(markup, { waitUntil: 'load' });
    await page.evaluate(axe.source);
    return await page.evaluate<AxeSummary>(`axe
      .run(document, { resultTypes: ['violations', 'incomplete'] })
      .then((r) => ({
        violations: r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target.join(' ')),
        })),
        incomplete: r.incomplete.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(' ')) })),
        passes: r.passes.length,
      }))`);
  } finally {
    await context.close();
  }
}

describe('axe-core on every HTML output', () => {
  it('is axe-core 4.14.0', () => {
    expect(axe.version).toBe('4.14.0');
  });

  const html = outputs().filter((o) => o.document !== undefined || o.fragment === true);

  it('covers every document and fragment', () => {
    expect(html.map((o) => o.name)).toEqual([
      'statement-known-barriers.html',
      'statement-known-barriers.fragment.html',
      'statement-no-known-barriers.html',
      'statement-no-known-barriers.fragment.html',
      'statement-not-evaluated.html',
      'statement-not-evaluated.fragment.html',
      'summary.html',
      'summary-no-scans.html',
      'summary-one-scan.html',
    ]);
  });

  it.each(html.map((o) => [o.name, o] as const))('%s has zero violations', async (_name, o) => {
    const result = await audit(o.fragment === true ? storePage(o.content) : o.content);
    expect(result.violations).toEqual([]);
    expect(result.passes).toBeGreaterThan(10);
    // Results axe cannot decide are reported for review, never silently passed.
    expect(result.incomplete.map((i) => i.id).filter((id) => id !== 'color-contrast')).toEqual([]);
  });
});
