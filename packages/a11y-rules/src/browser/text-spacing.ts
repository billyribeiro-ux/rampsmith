// Text-spacing override with clipping detection (PLAN §11, step 6; WCAG 2.2 SC 1.4.12,
// https://www.w3.org/TR/WCAG22/#text-spacing; failure F104,
// https://www.w3.org/WAI/WCAG22/Techniques/failures/F104). The override applies the four
// values of the criterion (line height 1.5, paragraph spacing 2, letter spacing 0.12 and word
// spacing 0.16 times the font size) and changes nothing else. A box that clips text it did
// not clip before is a violation; text that spills out of a fixed-size box goes to review,
// because the check cannot tell whether it covers other content. Method: ADR-114.
import type { Page } from 'playwright-core';
import { nextFrames, probe } from './call.ts';
import { runCapped, type CheckResult } from './run.ts';

export interface TextSpacingOptions {
  /** Hard cap in milliseconds. Default 8,000. */
  readonly timeoutMs?: number;
  /** Most findings of each kind. Default 20. */
  readonly maxFindings?: number;
}

export async function checkTextSpacing(
  page: Page,
  options: TextSpacingOptions = {},
): Promise<CheckResult> {
  const maxFindings = options.maxFindings ?? 20;
  return runCapped(
    'text-spacing',
    options.timeoutMs ?? 8_000,
    async (ctx) => {
      ctx.stats['candidates'] = await probe(page, 'textSpacingBefore');
      await probe(page, 'textSpacingApply');
      await nextFrames(page);
      await probe(page, 'quiet', 100, 500);
      if (ctx.expired()) return;
      let clipped = 0;
      let overflow = 0;
      for (const issue of await probe(page, 'textSpacingAfter')) {
        if (issue.kind === 'clipped' && clipped < maxFindings) {
          clipped += 1;
          ctx.report('rs-text-spacing-clipped', 'violation', issue.target);
        } else if (issue.kind === 'overflow' && overflow < maxFindings) {
          overflow += 1;
          ctx.report('rs-text-spacing-overlap', 'incomplete', issue.target);
        }
      }
    },
    async () => {
      await probe(page, 'textSpacingRemove');
    },
  );
}
