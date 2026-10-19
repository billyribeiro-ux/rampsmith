// Focus hidden behind sticky headers, banners or drawers (PLAN §11, step 6; WCAG 2.2 SC
// 2.4.11, https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum; failure F110). A focused
// element fails only when it is entirely hidden by author content; partly covered passes at AA
// (https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured). Browsers scroll a focused
// element to the nearest edge, so sticky footers show up tabbing forward and sticky headers
// tabbing backward: the check traverses both ways. Method: ADR-114.
import type { Page } from 'playwright-core';
import { probe } from './call.ts';
import { runCapped, type CheckResult } from './run.ts';

const INTERNAL_STOPS = 20;

export interface FocusObscuredOptions {
  /** Most tab stops per direction. Default 200. */
  readonly maxStops?: number;
  /** Hard cap in milliseconds. Default 15,000. */
  readonly timeoutMs?: number;
}

export async function checkFocusNotObscured(
  page: Page,
  options: FocusObscuredOptions = {},
): Promise<CheckResult> {
  const maxStops = options.maxStops ?? 200;
  return runCapped(
    'focus-obscured',
    options.timeoutMs ?? 15_000,
    async (ctx) => {
      await probe(page, 'prepareTraversal', 'top');
      const reported = new Set<number>();
      let total = 0;
      for (const key of ['Tab', 'Shift+Tab'] as const) {
        const seen = new Set<number>();
        let previousId = -1;
        let repeats = 0;
        for (let stops = 0; stops < maxStops && !ctx.expired(); stops += 1) {
          await page.keyboard.press(key);
          const result = await probe(page, 'obscured');
          if (result.kind === 'outside') break;
          // An element with its own internal stops stays focused for several presses.
          if (result.id === previousId && repeats < INTERNAL_STOPS) {
            repeats += 1;
            continue;
          }
          repeats = 0;
          previousId = result.id;
          if (seen.has(result.id)) break;
          seen.add(result.id);
          total += 1;
          if (result.kind === 'skipped' || result.obscuredBy === null) continue;
          if (reported.has(result.id)) continue;
          reported.add(result.id);
          ctx.report('rs-focus-obscured', 'violation', result.target, {
            obscuredBy: result.obscuredBy.join(' >>> '),
            direction: key === 'Tab' ? 'forward' : 'backward',
          });
        }
      }
      ctx.stats['tabStops'] = total;
    },
    async () => {
      await probe(page, 'endTraversal');
    },
  );
}
