import type { Browser } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkFocusNotObscured,
  checkKeyboard,
  checkMediaAutoplay,
  checkReflow,
  checkTextSpacing,
  type CheckResult,
} from '../src/index.ts';
import {
  launch,
  openFixture,
  startFixtureServer,
  stopFixtureServer,
  type FixturePage,
} from './harness.ts';

let browser: Browser;
let open: FixturePage | null = null;

beforeAll(async () => {
  await startFixtureServer();
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
  await stopFixtureServer();
});
afterEach(async () => {
  if (open !== null) {
    // No fixture may reach the network: every request stays on the fixture origin.
    expect(open.blocked).toEqual([]);
    await open.context.close();
    open = null;
  }
});

async function load(
  path: string,
  viewport?: { width: number; height: number },
): Promise<FixturePage> {
  open = await openFixture(browser, path, viewport === undefined ? {} : { viewport });
  return open;
}

function summary(result: CheckResult): string[] {
  return result.findings.map((f) => `${f.ruleId} ${f.outcome} ${f.target.join(' >>> ')}`);
}

describe('the clean control page', () => {
  it('passes every browser check with no findings', async () => {
    const { page } = await load('/clean.html');
    for (const check of [
      checkKeyboard,
      checkFocusNotObscured,
      checkReflow,
      checkTextSpacing,
      checkMediaAutoplay,
    ]) {
      const result = await check(page);
      expect(result.status, result.check).toBe('complete');
      expect(summary(result), result.check).toEqual([]);
    }
  });

  it('also passes at the 390 x 844 mobile viewport the scanner uses', async () => {
    const { page } = await load('/clean.html', { width: 390, height: 844 });
    for (const check of [
      checkKeyboard,
      checkFocusNotObscured,
      checkReflow,
      checkTextSpacing,
      checkMediaAutoplay,
    ]) {
      const result = await check(page);
      expect(result.status, result.check).toBe('complete');
      expect(summary(result), result.check).toEqual([]);
    }
  });

  it('runs every check under its hard time cap', async () => {
    const { page } = await load('/clean.html');
    for (const check of [
      checkKeyboard,
      checkFocusNotObscured,
      checkReflow,
      checkTextSpacing,
      checkMediaAutoplay,
    ]) {
      const started = performance.now();
      const result = await check(page, { timeoutMs: 1 });
      expect(result.status, result.check).toBe('timed_out');
      // The cap, plus at most 1 s of grace and 2 s of cleanup.
      expect(performance.now() - started, result.check).toBeLessThan(3_500);
    }
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
  });
});

describe('checkKeyboard', () => {
  it('finds the trap, the stop with no indicator and the off-screen stop', async () => {
    const { page } = await load('/seeded-keyboard.html');
    const result = await checkKeyboard(page);
    expect(result.status).toBe('complete');
    expect(summary(result).sort()).toEqual(
      [
        'rs-focus-indicator-missing violation #no-ring',
        'rs-focus-stop-hidden violation #clipped-link',
        'rs-focus-stop-hidden violation #offscreen-link',
        'rs-keyboard-trap violation #trap-a',
      ].sort(),
    );
    const trap = result.findings.find((f) => f.ruleId === 'rs-keyboard-trap');
    expect(trap).toMatchObject({
      criteria: ['2.1.2'],
      impact: 'critical',
      data: { cycleLength: 2 },
    });
    const reasons = result.findings
      .filter((f) => f.ruleId === 'rs-focus-stop-hidden')
      .map((f) => `${f.target.join('')} ${String(f.data?.['reason'])}`);
    expect(reasons.sort()).toEqual(['#clipped-link clipped', '#offscreen-link offscreen']);
  });

  it('leaves the page as it found it', async () => {
    const { page } = await load('/seeded-keyboard.html');
    await checkKeyboard(page, { maxStops: 3 });
    const leftovers = await page.evaluate(
      () => document.querySelectorAll('[data-rampsmith-probe],[data-rampsmith-sentinel]').length,
    );
    expect(leftovers).toBe(0);
  });

  it('stops at the time cap and returns what it found', async () => {
    const { page } = await load('/seeded-keyboard.html');
    const started = performance.now();
    const result = await checkKeyboard(page, { timeoutMs: 1 });
    expect(result.status).toBe('timed_out');
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('checkFocusNotObscured', () => {
  it('finds focus hidden under the fixed announcement bar and the cookie banner', async () => {
    const { page } = await load('/seeded-obscured.html');
    const result = await checkFocusNotObscured(page);
    expect(result.status).toBe('complete');
    expect(summary(result).sort()).toEqual([
      'rs-focus-obscured violation #under-banner',
      'rs-focus-obscured violation #under-bar',
    ]);
    const byTarget = new Map(result.findings.map((f) => [f.target.join(''), f.data]));
    expect(byTarget.get('#under-bar')).toEqual({
      obscuredBy: '#announcement-bar',
      direction: 'forward',
    });
    expect(byTarget.get('#under-banner')).toEqual({
      obscuredBy: '#cookie-banner',
      direction: 'forward',
    });
    for (const f of result.findings) {
      expect(f).toMatchObject({
        ruleId: 'rs-focus-obscured',
        criteria: ['2.4.11'],
        outcome: 'violation',
      });
    }
  });
});

describe('checkFocusNotObscured with a sticky header and a drawer', () => {
  it('finds focus under the drawer going forward and under the header going backward', async () => {
    const { page } = await load('/seeded-sticky-drawer.html');
    const result = await checkFocusNotObscured(page);
    expect(result.status).toBe('complete');
    const byTarget = new Map(result.findings.map((f) => [f.target.join(''), f.data]));
    expect([...byTarget.keys()].sort()).toEqual(['#late-link', '#under-drawer']);
    expect(byTarget.get('#under-drawer')).toEqual({
      obscuredBy: '#side-drawer',
      direction: 'forward',
    });
    expect(byTarget.get('#late-link')).toEqual({
      obscuredBy: '#site-header',
      direction: 'backward',
    });
  });
});

describe('checkReflow', () => {
  it('reports only the fixed-width element and restores the viewport', async () => {
    const { page } = await load('/seeded-reflow.html');
    const result = await checkReflow(page);
    expect(result.status).toBe('complete');
    expect(summary(result)).toEqual(['rs-reflow-horizontal-scroll violation #fixed-width']);
    expect(result.findings[0]?.data).toMatchObject({ viewportWidth: 320, causeFound: true });
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
  });
});

describe('checkTextSpacing', () => {
  it('reports the clipped box as a violation and the spilling box for review', async () => {
    const { page } = await load('/seeded-text-spacing.html');
    const result = await checkTextSpacing(page);
    expect(result.status).toBe('complete');
    expect(summary(result).sort()).toEqual([
      'rs-text-spacing-clipped violation #clipped-box',
      'rs-text-spacing-overlap incomplete #spill-box',
    ]);
    const leftovers = await page.evaluate(
      () => document.querySelectorAll('[data-rampsmith-probe]').length,
    );
    expect(leftovers).toBe(0);
  });
});

describe('checkMediaAutoplay', () => {
  it('reports uncontrolled autoplaying audio, and audio with only a nearby button for review', async () => {
    const { page } = await load('/seeded-media.html');
    const result = await checkMediaAutoplay(page);
    expect(result.status).toBe('complete');
    expect(summary(result).sort()).toEqual([
      'rs-media-autoplay-audio incomplete #nearby',
      'rs-media-autoplay-audio violation #bare',
    ]);
    expect(result.findings.find((f) => f.outcome === 'violation')?.data).toEqual({
      durationSeconds: 5,
      control: 'none',
      hasAudio: 'true',
    });
  });
});
