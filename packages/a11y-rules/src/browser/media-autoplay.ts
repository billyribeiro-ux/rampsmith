// Audio that plays automatically for more than 3 seconds with no control (PLAN §11, step 6;
// WCAG 2.2 SC 1.4.2, https://www.w3.org/TR/WCAG22/#audio-control). Applicability follows the
// ACT rule "audio or video element that plays automatically has a control mechanism"
// (https://www.w3.org/WAI/standards-guidelines/act/rules/auto-play-audio-has-control-mechanism-4c31df/)
// and F93 (https://www.w3.org/WAI/WCAG22/Techniques/failures/F93.html): autoplay (the
// attribute, or already playing), not muted, longer than 3 seconds, with audio. Browsers may
// block unmuted autoplay, so the page's intent (the attribute) counts, not the browser's
// policy. Native `controls` or an `aria-controls` instrument passes; a nearby named button
// sends the finding to review. Method: ADR-114.
import type { Page } from 'playwright-core';
import { probe } from './call.ts';
import type { MediaInfo } from './protocol.ts';
import { runCapped, type CheckResult } from './run.ts';

export interface MediaAutoplayOptions {
  /** Hard cap in milliseconds. Default 6,000. */
  readonly timeoutMs?: number;
  /** Longest wait for media metadata (the duration). Default 2,500 ms. */
  readonly metadataWaitMs?: number;
}

const autoplaying = (m: MediaInfo): boolean => (m.autoplay || m.playing) && !m.muted;

export async function checkMediaAutoplay(
  page: Page,
  options: MediaAutoplayOptions = {},
): Promise<CheckResult> {
  return runCapped('media-autoplay', options.timeoutMs ?? 6_000, async (ctx) => {
    const waitUntil = performance.now() + (options.metadataWaitMs ?? 2_500);
    let candidates = (await probe(page, 'media')).filter(autoplaying);
    while (
      candidates.some((m) => m.readyState < 1) &&
      performance.now() < waitUntil &&
      !ctx.expired()
    ) {
      await page.waitForTimeout(100);
      candidates = (await probe(page, 'media')).filter(autoplaying);
    }
    ctx.stats['autoplaying'] = candidates.length;
    for (const m of candidates) {
      if (ctx.expired()) break;
      if (m.controls) continue;
      const unknownDuration = m.duration < 0;
      const long = m.loop || m.duration > 3;
      if (!long && !unknownDuration) continue;
      const control = await probe(page, 'mediaControl', m.id);
      if (control === 'aria-controls') continue;
      const certain = control === 'none' && long && m.hasAudio === true;
      ctx.report('rs-media-autoplay-audio', certain ? 'violation' : 'incomplete', m.target, {
        durationSeconds: unknownDuration ? -1 : Math.min(Math.round(m.duration), 86_400),
        control,
        hasAudio: m.hasAudio === null ? 'unknown' : String(m.hasAudio),
      });
    }
  });
}
