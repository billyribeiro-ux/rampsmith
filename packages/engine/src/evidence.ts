/**
 * Evidence crops (PLAN §5 "What each fix must carry"; ADR-035): a small PNG of the area around a
 * failing element, kept in PostgreSQL (`evidence.bytes`, at most 64 KiB) and shown next to the
 * finding and, after the fix, next to the same area again.
 */
import type { Page } from 'playwright';

/** `evidence.bytes` holds at most this many bytes (migration 20261102000001). */
const MAX_CROP_BYTES = 65_536;

/** Crop sizes tried in turn until the PNG fits, CSS pixels. */
const SIZES = [
  { width: 480, height: 320 },
  { width: 320, height: 200 },
  { width: 200, height: 120 },
] as const;
const PADDING = 8;
const STEP_TIMEOUT_MS = 2_000;

/** A PNG of the area around the element `selector` names, or `undefined` when none fits. */
export async function cropOf(page: Page, selector: string): Promise<Buffer | undefined> {
  try {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
    const box = await locator.boundingBox({ timeout: STEP_TIMEOUT_MS });
    const viewport = page.viewportSize();
    if (box === null || viewport === null || box.width < 1 || box.height < 1) return undefined;
    for (const size of SIZES) {
      const x = Math.max(0, Math.min(box.x - PADDING, viewport.width - 1));
      const y = Math.max(0, Math.min(box.y - PADDING, viewport.height - 1));
      const clip = {
        x,
        y,
        width: Math.max(1, Math.min(box.width + 2 * PADDING, size.width, viewport.width - x)),
        height: Math.max(1, Math.min(box.height + 2 * PADDING, size.height, viewport.height - y)),
      };
      const png = await page.screenshot({
        clip,
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        timeout: STEP_TIMEOUT_MS,
      });
      if (png.length <= MAX_CROP_BYTES) return png;
    }
  } catch {
    // The element moved, vanished or never rendered: no crop, and the finding stands without one.
  }
  return undefined;
}
