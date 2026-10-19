// Layout and footprint in Chromium: no layout shift through every state (measured with the
// browser's layout-shift entries, as Core Web Vitals counts CLS), reflow at 320 CSS pixels
// with WCAG text spacing, target sizes, and a page left exactly as the theme made it.
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIN_ELAPSED_MS } from '../src/barrier-report.ts';
import { launch, layoutShift, observed, open, type OpenOptions } from '../src/browser.ts';
import {
  PSEUDO_CLOSE,
  PSEUDO_OPEN,
  flatten,
  pseudoTranslator,
  readLocale,
} from '../src/locales.ts';
import { STOREFRONT_LOCALE } from '../src/paths.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launch(inject('chromiumPath'));
});
afterAll(async () => {
  await browser.close();
});

const OPTIONS: OpenOptions = {
  statementMetafield: '/pages/accessibility-statement',
  settings: { show_report_form: true },
};
const TEXTAREA = 'textarea[name="description"]';
const EMAIL = 'input[name="email"]';
const SUBMIT = 'button[type="submit"]';

const waitForStatus = (page: Page, prefix: string) =>
  page.waitForFunction(
    (p) => document.querySelector('[data-rs-status]')?.textContent.startsWith(p) === true,
    prefix,
  );

/** Every state, with the slow answers arriving long after the last input. */
async function walkThrough(page: Page, proxy: { mode: string; delayMs: number }): Promise<void> {
  await page.click('summary');
  await page.click(SUBMIT);
  await page.fill(EMAIL, 'not-an-email');
  await page.click(SUBMIT);
  await page.fill(TEXTAREA, 'The size picker cannot be reached with the keyboard.');
  await page.fill(EMAIL, '');
  await page.waitForTimeout(MIN_ELAPSED_MS);
  proxy.delayMs = 1200;
  await page.click(SUBMIT);
  await waitForStatus(page, 'Thank you');
  proxy.mode = 'rate-limited';
  await page.fill(TEXTAREA, 'Second report');
  await page.click(SUBMIT);
  await waitForStatus(page, 'Too many');
  proxy.mode = 'server-error';
  await page.click(SUBMIT);
  await waitForStatus(page, 'Your report could not');
}

describe('layout shift', () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['320 px phone', { width: 320, height: 640 }],
  ] as const) {
    it(`is zero from load through every form state (${name})`, async () => {
      const fixture = await open(browser, { ...OPTIONS, viewport, tall: true });
      try {
        expect(await layoutShift(fixture.page), 'on load').toBe(0);
        await fixture.page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await walkThrough(fixture.page, fixture.proxy);
        expect(await layoutShift(fixture.page), 'after every state').toBe(0);
      } finally {
        await fixture.close();
      }
    });
  }

  it('is zero when the embed sits in view on a short page', async () => {
    const fixture = await open(browser, OPTIONS);
    try {
      await walkThrough(fixture.page, fixture.proxy);
      expect(await layoutShift(fixture.page)).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it('is measured for real: a late insertion above the embed registers as a shift', async () => {
    const fixture = await open(browser, OPTIONS);
    try {
      await fixture.page.waitForTimeout(600);
      await fixture.page.evaluate(() => {
        const block = document.createElement('div');
        block.style.height = '200px';
        document.querySelector('main')?.prepend(block);
      });
      await fixture.page.waitForTimeout(200);
      expect(await layoutShift(fixture.page)).toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });
});

describe('reflow and spacing (WCAG 1.4.10, 1.4.12)', () => {
  it('needs no horizontal scrolling at 320 CSS px, even with WCAG text spacing applied', async () => {
    const fixture = await open(browser, { ...OPTIONS, viewport: { width: 320, height: 640 } });
    const { page } = fixture;
    try {
      await page.click('summary');
      await page.click(SUBMIT);
      await page.addStyleTag({
        content:
          '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}',
      });
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped: [...document.querySelectorAll('[data-rampsmith-a11y] *')]
          .filter(
            (el) =>
              el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible',
          )
          .map((el) => el.tagName),
      }));
      expect(overflow).toEqual({ page: 0, clipped: [] });
    } finally {
      await fixture.close();
    }
  });
});

describe('target size (WCAG 2.5.8)', () => {
  it('makes the link, disclosure, fields and button at least 44 px tall and 24 px wide', async () => {
    const fixture = await open(browser, { ...OPTIONS, viewport: { width: 320, height: 640 } });
    try {
      await fixture.page.click('summary');
      for (const selector of ['a.rs-a11y__link', 'summary', TEXTAREA, EMAIL, SUBMIT]) {
        const box = await fixture.page.locator(selector).boundingBox();
        expect(box?.height ?? 0, selector).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0, selector).toBeGreaterThanOrEqual(24);
      }
      const policy = await fixture.page.locator('a.rs-a11y__inline-link').boundingBox();
      expect(policy?.height ?? 0).toBeGreaterThanOrEqual(24);
    } finally {
      await fixture.close();
    }
  });
});

describe('footprint', () => {
  it('writes no cookie or storage and changes nothing outside the embed', async () => {
    const fixture = await open(browser, OPTIONS);
    try {
      await walkThrough(fixture.page, fixture.proxy);
      const left = await fixture.page.evaluate(() => ({
        cookie: document.cookie,
        local: localStorage.length,
        session: sessionStorage.length,
      }));
      expect(left).toEqual({ cookie: '', local: 0, session: 0 });
      expect(await fixture.context.cookies()).toEqual([]);
      expect((await observed(fixture.page)).outside).toEqual([]);
      expect(fixture.blocked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('requests no script at all when the form is off', async () => {
    const fixture = await open(browser, { statementMetafield: '/pages/a' });
    try {
      expect(fixture.assets).toEqual([]);
      expect(fixture.blocked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('runs its script after the document is parsed (defer)', async () => {
    const fixture = await open(browser, OPTIONS);
    try {
      const timing = await fixture.page.evaluate(() => {
        const [entry] = performance
          .getEntriesByType('resource')
          .filter((e) => e.name.endsWith('.js'));
        const nav = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined;
        return {
          loaded: entry !== undefined,
          novalidate: document.querySelector('form')?.noValidate,
          parsed: nav?.domInteractive ?? -1,
        };
      });
      expect(timing).toMatchObject({ loaded: true, novalidate: true });
      expect(timing.parsed).toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });
});

describe('messages the script writes', () => {
  it('come only from the locale files', async () => {
    const strings = flatten(readLocale(STOREFRONT_LOCALE));
    const fixture = await open(browser, { ...OPTIONS, translate: pseudoTranslator(strings) });
    const { page, proxy } = fixture;
    try {
      const texts: string[] = [];
      const embedText = () =>
        page.$eval('[data-rampsmith-a11y]', (el) => (el as HTMLElement).innerText);
      await page.click('summary');
      await page.fill(EMAIL, 'x');
      await page.click(SUBMIT);
      texts.push(await embedText());
      await page.fill(TEXTAREA, 'Report');
      await page.fill(EMAIL, '');
      proxy.mode = 'rate-limited';
      await page.click(SUBMIT);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-rs-status]')?.textContent.includes('rate_limited') === true,
      );
      texts.push(await embedText());
      const markers = new RegExp(`${PSEUDO_OPEN}[a-z0-9_.]+${PSEUDO_CLOSE}`, 'gu');
      for (const text of texts) expect(text.replaceAll(markers, '').trim()).toBe('');
      expect(texts[0]).toContain(`${PSEUDO_OPEN}report.errors.description_missing${PSEUDO_CLOSE}`);
    } finally {
      await fixture.close();
    }
  });
});
