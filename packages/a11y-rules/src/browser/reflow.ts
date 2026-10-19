// Reflow at 320 CSS pixels (PLAN §11, step 6; WCAG 2.2 SC 1.4.10,
// https://www.w3.org/TR/WCAG22/#reflow). "320 CSS pixels is equivalent to a starting viewport
// width of 1280 CSS pixels wide at 400% zoom" (https://www.w3.org/WAI/WCAG22/Understanding/reflow).
// Content that needs two dimensions (tables, images, video, maps, canvases, embeds) is exempt,
// as are boxes that scroll or clip horizontally. Method: ADR-114.
import type { Page } from 'playwright-core';
import { nextFrames, probe } from './call.ts';
import { runCapped, type CheckResult } from './run.ts';

export interface ReflowOptions {
  /** Viewport width in CSS pixels. Default 320. */
  readonly width?: number;
  /** Hard cap in milliseconds. Default 8,000. */
  readonly timeoutMs?: number;
  /** Longest wait for the layout to settle after resizing. Default 1,500 ms. */
  readonly settleMs?: number;
}

export async function checkReflow(page: Page, options: ReflowOptions = {}): Promise<CheckResult> {
  const width = options.width ?? 320;
  const original = page.viewportSize();
  return runCapped(
    'reflow',
    options.timeoutMs ?? 8_000,
    async (ctx) => {
      if (original === null) throw new Error('the page has no fixed viewport to resize');
      await page.setViewportSize({ width, height: original.height });
      await probe(page, 'quiet', 150, options.settleMs ?? 1_500);
      await nextFrames(page);
      if (ctx.expired()) return;
      const result = await probe(page, 'reflow');
      ctx.stats['viewportWidth'] = result.viewportWidth;
      ctx.stats['scrollWidth'] = result.scrollWidth;
      for (const culprit of result.culprits) {
        const causeFound = culprit.target.join('') !== 'html';
        ctx.report(
          'rs-reflow-horizontal-scroll',
          causeFound ? 'violation' : 'incomplete',
          culprit.target,
          { overflowPx: culprit.overflowPx, viewportWidth: result.viewportWidth, causeFound },
        );
      }
    },
    async () => {
      if (original !== null) await page.setViewportSize(original);
    },
  );
}
