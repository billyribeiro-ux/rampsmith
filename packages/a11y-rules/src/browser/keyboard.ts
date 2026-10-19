// Keyboard traversal (PLAN §11, step 6): up to 200 tab stops, flagging keyboard traps
// (WCAG 2.2 SC 2.1.2, https://www.w3.org/TR/WCAG22/#no-keyboard-trap), stops with no visible
// focus indicator and stops on invisible elements (SC 2.4.7, F78:
// https://www.w3.org/WAI/WCAG22/Techniques/failures/F78). Method: ADR-114.
import type { Page } from 'playwright-core';
import { nextFrames, probe } from './call.ts';
import type { IndicatorVerdict, Target } from './protocol.ts';
import { runCapped, type CheckContext, type CheckResult } from './run.ts';

export interface KeyboardOptions {
  /** Most tab stops visited. Default 200 (PLAN §11). */
  readonly maxStops?: number;
  /** Hard cap in milliseconds. Default 15,000. */
  readonly timeoutMs?: number;
  /** Start from the top of the page (default) or from wherever focus is now. */
  readonly start?: 'top' | 'current';
  /** Most indicator candidates confirmed by screenshot. Default 20. */
  readonly confirmLimit?: number;
}

/** Consecutive Tab presses that may stay on one element before focus counts as stuck. */
const INTERNAL_STOPS = 20;

/** Whether focusing the element changes no pixel around it, compared by screenshots. */
async function indicatorInvisible(page: Page, id: number): Promise<boolean> {
  const clip = await probe(page, 'focusById', id);
  if (clip === null) return false;
  await nextFrames(page);
  const shot = { clip, animations: 'disabled', caret: 'hide', scale: 'css' } as const;
  const focused = await page.screenshot(shot);
  await probe(page, 'focusSentinel');
  await nextFrames(page);
  const unfocused = await page.screenshot(shot);
  return focused.equals(unfocused);
}

/** After a suspected trap, Escape then Tab must move focus out of the cycle. */
async function escapes(
  page: Page,
  cycle: ReadonlySet<number>,
  ctx: CheckContext,
): Promise<boolean> {
  await page.keyboard.press('Escape');
  for (let i = 0; i <= cycle.size + 1 && !ctx.expired(); i += 1) {
    await page.keyboard.press('Tab');
    const step = await probe(page, 'step');
    if (step.kind === 'outside' || !cycle.has(step.id)) return true;
  }
  return false;
}

export async function checkKeyboard(
  page: Page,
  options: KeyboardOptions = {},
): Promise<CheckResult> {
  const maxStops = options.maxStops ?? 200;
  const confirmLimit = options.confirmLimit ?? 20;
  return runCapped(
    'keyboard',
    options.timeoutMs ?? 15_000,
    async (ctx) => {
      await probe(page, 'prepareTraversal', options.start ?? 'top');
      const order: number[] = [];
      const seenAt = new Map<number, number>();
      const targets = new Map<number, Target>();
      const hiddenReported = new Set<number>();
      const candidates: IndicatorVerdict[] = [];
      const internal = new Set<number>();
      let stops = 0;
      let repeats = 0;
      let previousId = -1;

      while (stops < maxStops && !ctx.expired()) {
        await page.keyboard.press('Tab');
        const step = await probe(page, 'step');
        if (step.previous !== null && !step.previous.changed) candidates.push(step.previous);
        if (step.kind === 'outside') {
          ctx.stats['completedCycle'] = 1;
          break;
        }
        // Tabbing through an element's own stops (a frame, media controls, date fields) keeps
        // it focused from the page's point of view. Past INTERNAL_STOPS repeats, focus is
        // treated as stuck and goes through the trap test below.
        if (step.id === previousId) {
          internal.add(step.id);
          repeats += 1;
          if (repeats < INTERNAL_STOPS) continue;
        } else {
          repeats = 0;
          previousId = step.id;
          stops += 1;
        }
        if (step.hidden !== null && !hiddenReported.has(step.id)) {
          hiddenReported.add(step.id);
          ctx.report('rs-focus-stop-hidden', 'violation', step.target, { reason: step.hidden });
        }
        const firstSeen = seenAt.get(step.id);
        if (firstSeen !== undefined) {
          const cycle = order.slice(firstSeen);
          ctx.stats['cycleLength'] = cycle.length;
          if (firstSeen === 0) break;
          const tabbable = await probe(page, 'tabbableCount');
          if (cycle.length >= tabbable) break;
          if (await probe(page, 'cycleInModalWithButton', cycle)) {
            ctx.stats['stoppedInModal'] = 1;
            break;
          }
          if (!(await escapes(page, new Set(cycle), ctx))) {
            const first = cycle[0];
            const target = first === undefined ? step.target : (targets.get(first) ?? step.target);
            ctx.report('rs-keyboard-trap', 'violation', target, { cycleLength: cycle.length });
          }
          break;
        }
        seenAt.set(step.id, order.length);
        order.push(step.id);
        targets.set(step.id, step.target);
      }
      ctx.stats['tabStops'] = stops;
      ctx.stats['indicatorCandidates'] = candidates.length;

      const confirmed = new Set<number>();
      for (const candidate of candidates.slice(0, confirmLimit)) {
        if (ctx.expired()) break;
        if (confirmed.has(candidate.id) || hiddenReported.has(candidate.id)) continue;
        if (internal.has(candidate.id)) continue;
        confirmed.add(candidate.id);
        if (await indicatorInvisible(page, candidate.id)) {
          ctx.report('rs-focus-indicator-missing', 'violation', candidate.target);
        }
      }
    },
    async () => {
      await probe(page, 'endTraversal');
    },
  );
}
