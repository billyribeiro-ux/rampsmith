/**
 * Core Web Vitals of every App Home screen against the typed fake api, on a throttled mobile
 * profile (PLAN §5 R2: "admin LCP, CLS and INP inside Built for Shopify thresholds in CI";
 * PLAN §23 budgets; ADR-300).
 *
 * Each screen is loaded cold `LOADS` times. LCP and CLS come from the load; INP comes from
 * scripted interactions on the loaded screen (approve, edit, filter, navigate, type, save).
 * The 75th percentile of the loads is compared with the budget, as Shopify does with page
 * loads. What Shopify's Polaris and App Bridge scripts cost is not measured: they come from
 * Shopify's CDN and the tests serve the Polaris shim in their place (ADR-094, ADR-300).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { open, section } from './app-helpers.ts';
import type { ScenarioName } from './app-fake-api.ts';
import {
  BUDGET,
  BUILT_FOR_SHOPIFY,
  collectVitals,
  percentile,
  readVitals,
  scriptBytes,
  throttle,
  type Vitals,
} from './perf-helpers.ts';

/** Cold loads per screen for LCP and CLS, and scripted journeys per screen for INP. */
const LOADS = Number(process.env['RAMPSMITH_PERF_LOADS'] ?? 5);
const JOURNEYS = Number(process.env['RAMPSMITH_PERF_JOURNEYS'] ?? 2);
const TOTE_FINDING = '00000000-0000-4000-8000-000000000102';

interface Screen {
  name: string;
  scenario: ScenarioName;
  path: string;
  heading: string | RegExp;
  /** Something only the loaded data renders, so the load is measured to the real content. */
  ready: (page: Page) => Promise<void>;
  /** The interactions a merchant makes on this screen. Every one is a real key or pointer event. */
  interact: (page: Page) => Promise<void>;
}

/** Types like a person: one key at a time, a frame apart. */
const type = (page: Page, text: string): Promise<void> => page.keyboard.type(text, { delay: 40 });

const SCREENS: Screen[] = [
  {
    name: 'overview',
    scenario: 'default',
    path: '/app',
    heading: 'Overview',
    ready: (p) => expect(section(p, 'Latest scan')).toContainText('Finished'),
    interact: async (p) => {
      await p.getByRole('link', { name: 'View all issues' }).click();
      await expect(p.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
    },
  },
  {
    name: 'overview, first scan',
    scenario: 'fresh',
    path: '/app',
    heading: 'Overview',
    ready: (p) => expect(p.getByRole('heading', { name: 'No scan yet' })).toBeVisible(),
    interact: async (p) => {
      await p.locator('s-empty-state').getByRole('button', { name: 'Start a scan' }).click();
      await expect(section(p, 'Latest scan')).toContainText('Finished', { timeout: 30_000 });
    },
  },
  {
    name: 'issues',
    scenario: 'default',
    path: '/app/findings',
    heading: 'Issues',
    ready: (p) => expect(p.getByText('Issues: 7').first()).toBeVisible(),
    interact: async (p) => {
      // A filter is a select: ArrowDown on the focused control changes it, as a key press does.
      const impact = p.getByRole('combobox', { name: 'Impact' });
      await impact.focus();
      await p.keyboard.press('ArrowDown');
      await expect(p.getByText(/Issues: \d+/).first()).toBeVisible();
      await impact.press('ArrowUp');
      await p.getByRole('combobox', { name: 'Found in' }).focus();
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('ArrowUp');
      await p
        .getByRole('link', { name: 'The image of Linen tote bag has no useful description' })
        .click();
      await expect(p).toHaveURL(new RegExp(`/app/findings/${TOTE_FINDING}`));
      await expect(p.getByText('Images need a short text description')).toBeVisible();
    },
  },
  {
    name: 'issue detail',
    scenario: 'default',
    path: `/app/findings/${TOTE_FINDING}`,
    heading: /./,
    ready: (p) => expect(p.getByText('Images need a short text description')).toBeVisible(),
    interact: async (p) => {
      await section(p, 'Fixes').getByRole('link').first().click();
      await expect(p.getByRole('heading', { level: 1, name: 'Review fixes' })).toBeVisible();
    },
  },
  {
    name: 'fixes',
    scenario: 'default',
    path: '/app/fixes',
    heading: 'Review fixes',
    ready: (p) => expect(section(p, 'Applied changes')).toContainText('Linen tote bag'),
    interact: async (p) => {
      await p.getByRole('button', { name: 'Edit alt text for Brass desk lamp' }).click();
      const field = p.getByRole('textbox', { name: 'Alt text' });
      await expect(field).toBeFocused();
      await p.keyboard.press('Control+A');
      await type(p, 'A small brass lamp with a green glass shade');
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Approve alt text for Brass desk lamp' }).click();
      await expect(p.locator('.live')).toHaveText(/Approved the alt text for Brass desk lamp/);
      await expect(
        section(p, 'Applied changes').getByRole('heading', {
          level: 3,
          name: 'Brass desk lamp',
        }),
      ).toBeVisible({ timeout: 20_000 });
      await p.getByRole('button', { name: 'Undo alt text change for Brass desk lamp' }).click();
      await expect(p.locator('.live')).toContainText(/Undid the alt text change/);
    },
  },
  {
    name: 'remediation log',
    scenario: 'default',
    path: '/app/log',
    heading: 'Remediation log',
    ready: (p) => expect(p.getByRole('row').filter({ hasText: 'Blue ceramic mug' })).toBeVisible(),
    interact: async (p) => {
      for (const name of ['Download CSV', 'Download JSON']) {
        const download = p.waitForEvent('download');
        await p.getByRole('button', { name }).click();
        await download;
        await expect(p.locator('.live')).toContainText('Downloaded');
      }
    },
  },
  {
    name: 'statement',
    scenario: 'default',
    path: '/app/statement',
    heading: 'Accessibility statement',
    ready: (p) => expect(p.getByRole('textbox', { name: 'Business name' })).toBeVisible(),
    interact: async (p) => {
      await p.getByRole('textbox', { name: 'Business name' }).click();
      await p.keyboard.press('Control+A');
      await type(p, 'Demo Store Ltd');
      await p.getByRole('textbox', { name: /^Email/ }).click();
      await p.keyboard.press('Control+A');
      await type(p, 'access@demo-store.example');
      await p.getByRole('button', { name: 'Add a known barrier' }).click();
      await p.getByRole('button', { name: 'Remove known barrier 1' }).click();
      await p.getByRole('button', { name: 'Save' }).click();
      await expect(p.locator('.live')).toHaveText('Statement saved.');
    },
  },
  {
    name: 'settings',
    scenario: 'default',
    path: '/app/settings',
    heading: 'Settings',
    ready: (p) => expect(p.getByRole('switch', { name: 'Rescan every week' })).toBeVisible(),
    interact: async (p) => {
      await p.getByRole('switch', { name: 'Rescan every week' }).check();
      await p.getByRole('textbox', { name: 'Notification email' }).click();
      await p.keyboard.press('Control+A');
      await type(p, 'team@demo-store.example');
      await p.getByRole('button', { name: 'Save' }).click();
      await expect(p.locator('.live')).toHaveText('Settings saved.');
    },
  },
];

interface Run extends Vitals {
  scriptBytes: number;
}

const results: Record<string, unknown> = {};

/** A fresh mobile browser context with the collector and the throttle, opened on the screen. */
async function openCold(
  browser: Browser,
  baseURL: string | undefined,
  screen: Screen,
): Promise<{ page: Page; close: () => Promise<void> }> {
  if (baseURL === undefined) throw new Error('the app-perf project sets a baseURL');
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await collectVitals(page);
  await throttle(page);
  await open(page, screen.scenario, screen.path, screen.heading);
  await screen.ready(page);
  await page.waitForLoadState('networkidle');
  return { page, close: () => context.close() };
}

test('percentile is the nearest rank', () => {
  expect(percentile([5, 1, 4, 2, 3], 0.75)).toBe(4);
  expect(percentile([10], 0.75)).toBe(10);
  expect(percentile([1, 2, 3, 4], 0.75)).toBe(3);
  expect(() => percentile([], 0.75)).toThrow();
});

for (const screen of SCREENS) {
  test(`${screen.name}: LCP, CLS and INP are inside the budgets`, async ({ browser, baseURL }) => {
    test.setTimeout((LOADS + JOURNEYS) * 60_000);

    // LCP and CLS of the load, and the size of the JavaScript the load needs.
    const loads: Run[] = [];
    for (let i = 0; i < LOADS; i++) {
      const { page, close } = await openCold(browser, baseURL, screen);
      const bytes = await scriptBytes(page);
      loads.push({ ...(await readVitals(page)), scriptBytes: bytes });
      await close();
    }

    // INP of the interactions, and the CLS of the whole visit including them.
    const journeys: Run[] = [];
    for (let i = 0; i < JOURNEYS; i++) {
      const { page, close } = await openCold(browser, baseURL, screen);
      await screen.interact(page);
      // Event Timing reports an interaction after its next paint.
      await page.waitForTimeout(600);
      journeys.push({ ...(await readVitals(page)), scriptBytes: 0 });
      await close();
    }

    const lcp = loads.map((r) => r.lcp).filter((v): v is number => v !== null);
    const inp = journeys.map((r) => r.inp).filter((v): v is number => v !== null);
    expect(lcp.length, 'no LCP was reported').toBe(loads.length);
    expect(inp.length, 'no INP was reported: the interactions did not register').toBe(
      journeys.length,
    );
    const p75 = {
      lcpMs: percentile(lcp, 0.75),
      clsLoad: percentile(
        loads.map((r) => r.cls),
        0.75,
      ),
      clsVisit: percentile(
        journeys.map((r) => r.cls),
        0.75,
      ),
      inpMs: percentile(inp, 0.75),
      scriptBytes: Math.max(...loads.map((r) => r.scriptBytes)),
    };
    results[screen.name] = { p75, loads, journeys };
    test.info().annotations.push({ type: 'p75', description: JSON.stringify(p75) });

    const where = (
      runs: Run[],
      key: 'lcpElement' | 'clsTarget' | 'inpTarget' | 'inpPhases',
    ): string => runs.map((r) => r[key] ?? '-').join(' | ');
    // LCP is bound by round trips on the throttled link, so it is the one metric that moves
    // with the CI runner: it fails at Built for Shopify's threshold and warns at the PLAN §23
    // budget, which the summary shows (ADR-300). CLS, INP and script size fail at the budget.
    expect
      .soft(p75.lcpMs, `LCP p75 ${where(loads, 'lcpElement')}`)
      .toBeLessThan(BUILT_FOR_SHOPIFY.lcpMs);
    if (p75.lcpMs >= BUDGET.lcpMs) {
      test.info().annotations.push({
        type: 'warning',
        description: `LCP p75 ${String(Math.round(p75.lcpMs))} ms is over the ${String(BUDGET.lcpMs)} ms headroom budget`,
      });
    }
    expect
      .soft(p75.clsLoad, `CLS of the load ${where(loads, 'clsTarget')}`)
      .toBeLessThan(BUDGET.cls);
    expect
      .soft(p75.clsVisit, `CLS of the visit ${where(journeys, 'clsTarget')}`)
      .toBeLessThan(BUDGET.cls);
    expect
      .soft(
        p75.inpMs,
        `INP p75 ${where(journeys, 'inpTarget')} (type, input delay, processing, presentation: ${where(journeys, 'inpPhases')})`,
      )
      .toBeLessThan(BUDGET.inpMs);
    expect.soft(p75.scriptBytes, 'compressed JavaScript').toBeLessThanOrEqual(BUDGET.scriptBytes);
  });
}

test.afterAll(() => {
  mkdirSync('test-results/perf', { recursive: true });
  writeFileSync(
    'test-results/perf/app-home.json',
    `${JSON.stringify({ budget: BUDGET, builtForShopify: BUILT_FOR_SHOPIFY, loads: LOADS, journeys: JOURNEYS, screens: results }, null, 2)}\n`,
  );
});
