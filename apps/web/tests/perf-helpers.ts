/**
 * Core Web Vitals for the embedded App Home (PLAN §23 "Performance budgets in CI", ADR-300).
 *
 * `web-vitals` (the library Shopify's own documentation points to for Web Vitals) is read from
 * the pinned npm package and injected into every document before the app runs. Nothing is
 * loaded from a CDN. The browser is throttled the way Lighthouse's mobile preset throttles it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

/**
 * The budgets the build fails on. PLAN §23 sets them stricter than Built for Shopify so that
 * production has headroom. Built for Shopify (achievement criteria 2.1.1 to 2.1.3, read
 * 23 October 2026, ADR-300): LCP 2.5 s, CLS 0.1, INP 200 ms, each at the 75th percentile of
 * page loads over 28 days.
 */
export const BUDGET = {
  lcpMs: 2000,
  cls: 0.05,
  inpMs: 150,
  /** Initial JavaScript for the embedded admin, compressed (PLAN §23). */
  scriptBytes: 150 * 1024,
} as const;

export const BUILT_FOR_SHOPIFY = { lcpMs: 2500, cls: 0.1, inpMs: 200 } as const;

/** A mid-tier phone on a slow 4G link: Lighthouse's mobile preset (4x CPU, 150 ms, 1.6 Mbps). */
const THROTTLE = {
  cpuSlowdown: 4,
  latencyMs: 150,
  downloadBytesPerSecond: (1.6 * 1024 * 1024) / 8,
  uploadBytesPerSecond: (750 * 1024) / 8,
} as const;

export interface Vitals {
  lcp: number | null;
  lcpElement: string | null;
  cls: number;
  clsTarget: string | null;
  inp: number | null;
  inpTarget: string | null;
  /** Where the slowest interaction spent its time: input delay, processing, presentation. */
  inpPhases: string | null;
}

const require = createRequire(import.meta.url);
/** The attribution build names the element behind an LCP or an INP, which makes a failure fixable. */
const WEB_VITALS = readFileSync(require.resolve('web-vitals/attribution'), 'utf8');

const COLLECTOR = `(() => {
  const v = (globalThis.__vitals = { lcp: null, lcpElement: null, cls: 0, clsTarget: null, inp: null, inpTarget: null, inpPhases: null });
  const w = globalThis.webVitals;
  w.onLCP((m) => { v.lcp = m.value; v.lcpElement = m.attribution.target ?? null; }, { reportAllChanges: true });
  w.onCLS((m) => { v.cls = m.value; v.clsTarget = m.attribution.largestShiftTarget ?? null; }, { reportAllChanges: true });
  w.onINP((m) => { v.inp = m.value; v.inpTarget = m.attribution.interactionTarget ?? null; const a = m.attribution; v.inpPhases = [a.interactionType, Math.round(a.inputDelay), Math.round(a.processingDuration), Math.round(a.presentationDelay)].join(' '); }, { reportAllChanges: true });
})();`;

/** Adds the collector to every document the page opens. Call before the first navigation. */
export async function collectVitals(page: Page): Promise<void> {
  await page.addInitScript({ content: WEB_VITALS });
  await page.addInitScript({ content: COLLECTOR });
}

/** Applies the CPU and network throttle through the DevTools protocol. */
export async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuSlowdown });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE.latencyMs,
    downloadThroughput: THROTTLE.downloadBytesPerSecond,
    uploadThroughput: THROTTLE.uploadBytesPerSecond,
  });
}

export async function readVitals(page: Page): Promise<Vitals> {
  return page.evaluate(() => (globalThis as unknown as { __vitals: Vitals }).__vitals);
}

/**
 * Compressed bytes of same-origin JavaScript the document fetched. Shopify's App Bridge and
 * Polaris come from Shopify's CDN (stubbed here) and are not the app's to budget.
 */
export async function scriptBytes(page: Page): Promise<number> {
  return page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => e.name.startsWith(location.origin) && e.name.endsWith('.js'))
      .reduce((sum, e) => sum + (e as PerformanceResourceTiming).encodedBodySize, 0),
  );
}

/** Nearest-rank percentile: the smallest sample with at least `p` of the samples at or below it. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  if (value === undefined) throw new Error('percentile of no samples');
  return value;
}
