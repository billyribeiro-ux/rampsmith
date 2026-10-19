/**
 * Every email in Chromium (ADR-194): axe-core with the WCAG 2.2 A and AA rules plus best
 * practices, in light and dark mode, with every network request blocked (images off, no
 * remote content), and reflow at 320 CSS pixels (WCAG 1.4.10). Pseudo-locales check text
 * expansion and right-to-left layout.
 */
import axe from 'axe-core';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailRenderer, type RenderedEmail } from '../src/index.ts';
import { PALETTES } from '../src/render-html.ts';
import { launchChromium, type LaunchedBrowser } from './chromium.ts';
import { allFixtures, SETTINGS } from './fixtures.ts';
import { renderAll } from './helpers.ts';
import { pseudoCatalogs } from './pseudo.ts';

const AXE_OPTIONS = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  },
  resultTypes: ['violations', 'incomplete'],
  rules: {
    // An email body is shown inside the mail client's own page, which owns the landmarks; a
    // second <main> there would be wrong. The body is one role="article" instead (ADR-192).
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
  },
};

interface AxeIssue {
  readonly id: string;
  readonly nodes: readonly { readonly target: readonly unknown[] }[];
}

interface AxeOutcome {
  readonly violations: readonly AxeIssue[];
  readonly incomplete: readonly AxeIssue[];
}

function summarise(issues: readonly AxeIssue[]): string[] {
  return issues.map((i) => `${i.id}: ${i.nodes.map((n) => JSON.stringify(n.target)).join(' ')}`);
}

let launched: LaunchedBrowser;
let context: BrowserContext;
let page: Page;
const requests: string[] = [];

// One context and one page for the whole suite: @sparticuz/chromium runs Chromium in
// single-process mode, where a second browser context can hang.
beforeAll(async () => {
  launched = await launchChromium();
  process.stderr.write(
    `email browser tests: Chromium ${launched.browser.version()} from ${launched.source}\n`,
  );
  context = await launched.browser.newContext();
  context.on('request', (request) => requests.push(request.url()));
  await context.route('**/*', (route) => route.abort());
  page = await context.newPage();
});

afterAll(async () => {
  await context.close();
  await launched.browser.close();
});

/** Loads `html` with every network request blocked and recorded. */
async function open(html: string, colorScheme: 'light' | 'dark'): Promise<void> {
  requests.length = 0;
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ colorScheme });
  await page.setContent(html, { waitUntil: 'load' });
}

async function runAxe(): Promise<AxeOutcome> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate<AxeOutcome>(`axe.run(document, ${JSON.stringify(AXE_OPTIONS)})`);
}

/** Horizontal overflow in CSS pixels at a 320-pixel viewport. */
async function overflowAt320(): Promise<number> {
  await page.setViewportSize({ width: 320, height: 640 });
  return page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
}

async function check(email: RenderedEmail, colorScheme: 'light' | 'dark'): Promise<void> {
  await open(email.html, colorScheme);
  const outcome = await runAxe();
  expect(summarise(outcome.violations)).toEqual([]);
  // A "needs review" result means axe could not decide, such as a contrast it could not
  // compute; the emails are simple enough that every check must decide.
  expect(summarise(outcome.incomplete)).toEqual([]);
  expect(requests).toEqual([]);
  if (colorScheme === 'dark') {
    const card = await page.evaluate(
      'getComputedStyle(document.querySelector(".rs-card")).backgroundColor',
    );
    expect(card).toBe(rgb(PALETTES.dark.card));
  }
  expect(await overflowAt320()).toBeLessThanOrEqual(0);
}

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

describe.each(renderAll())('$kind ($name) in Chromium', ({ email }) => {
  it('passes axe in light mode, loads nothing and reflows at 320px', async () => {
    await check(email, 'light');
  });

  it('passes axe in dark mode', async () => {
    await check(email, 'dark');
  });
});

describe('pseudo-locales', () => {
  const renderer = createEmailRenderer(SETTINGS, { catalogs: pseudoCatalogs() });
  const firsts = allFixtures().filter(
    ([kind, name]) => name === allFixtures().find(([k]) => k === kind)?.[1],
  );

  it.each(firsts)('%s with 40%% longer text passes axe and reflows', async (kind, _name, input) => {
    const email = renderer.renderUnknown(kind, { ...(input as object), locale: 'en-XA' });
    expect(email.lang).toBe('en-XA');
    await check(email, 'light');
  });

  it.each(firsts)('%s right to left passes axe and reflows', async (kind, _name, input) => {
    const email = renderer.renderUnknown(kind, { ...(input as object), locale: 'ar-XB' });
    expect(email.html).toContain('<html lang="ar-XB" dir="rtl">');
    await check(email, 'dark');
  });
});

describe('the harness itself', () => {
  const email = renderAll()[0]?.email;

  it('catches low contrast in light mode', async () => {
    const html = (email?.html ?? '').replaceAll('color:#4b5563', 'color:#b0b6bf');
    await open(html, 'light');
    const outcome = await runAxe();
    expect(outcome.violations.map((v) => v.id)).toContain('color-contrast');
  });

  it('catches low contrast in dark mode only when dark styles apply', async () => {
    const html = (email?.html ?? '').replace('.rs-muted{color:#b6c0cc', '.rs-muted{color:#3a4350');
    await open(html, 'dark');
    expect((await runAxe()).violations.map((v) => v.id)).toContain('color-contrast');
    await open(html, 'light');
    expect((await runAxe()).violations.map((v) => v.id)).not.toContain('color-contrast');
  });

  it('catches horizontal overflow at 320px', async () => {
    await open(
      (email?.html ?? '').replace('</h1>', '</h1><div style="width:500px">x</div>'),
      'light',
    );
    expect(await overflowAt320()).toBeGreaterThan(0);
  });

  it('records a request for a remote image', async () => {
    await open(
      '<!doctype html><html lang="en"><title>x</title><img src="https://tracker.example/p.gif" alt=""></html>',
      'light',
    );
    expect(requests).toEqual(['https://tracker.example/p.gif']);
  });
});
