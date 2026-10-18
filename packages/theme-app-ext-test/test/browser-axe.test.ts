// axe-core in Chromium on the storefront fixture with the embed enabled: WCAG 2.2 A and AA plus
// axe's best practices, in every colour scheme, on light and dark themes, and in every state
// the form can be in, with and without the script.
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { axe, launch, open, type OpenOptions } from '../src/browser.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launch(inject('chromiumPath'));
});
afterAll(async () => {
  await browser.close();
});

const full: OpenOptions = {
  statementMetafield: '/pages/accessibility-statement',
  settings: { show_report_form: true },
};
const TEXTAREA = 'textarea[name="description"]';
const SUBMIT = 'button[type="submit"]';

describe('axe finds nothing', () => {
  const variants: [string, OpenOptions][] = [
    ['theme colours on a light theme', { ...full, tone: 'light' }],
    ['theme colours on a dark theme', { ...full, tone: 'dark' }],
    [
      'the light scheme on a dark theme',
      { ...full, tone: 'dark', settings: { ...full.settings, color_scheme: 'light' } },
    ],
    [
      'the dark scheme on a light theme',
      { ...full, tone: 'light', settings: { ...full.settings, color_scheme: 'dark' } },
    ],
  ];

  for (const [name, options] of variants) {
    it(`in each form state: ${name}`, async () => {
      const fixture = await open(browser, options);
      const { page } = fixture;
      try {
        expect(await axe(page), 'closed').toEqual([]);
        await page.click('summary');
        expect(await axe(page), 'open').toEqual([]);
        await page.click(SUBMIT);
        await page.fill('input[name="email"]', 'not-an-email');
        await page.click(SUBMIT);
        expect(await page.getAttribute(TEXTAREA, 'aria-invalid')).toBe('true');
        expect(await axe(page), 'errors shown').toEqual([]);
        fixture.proxy.mode = 'rate-limited';
        await page.fill(TEXTAREA, 'The size picker cannot be reached with the keyboard.');
        await page.fill('input[name="email"]', '');
        await page.click(SUBMIT);
        await page.waitForSelector('[data-rs-status]:not(:empty)');
        await page.waitForFunction(() =>
          document.querySelector('[data-rs-status]')?.textContent.startsWith('Too many'),
        );
        expect(await axe(page), 'status shown').toEqual([]);
      } finally {
        await fixture.close();
      }
    });
  }

  it('with the link only, the theme-editor notice, and the form without its script', async () => {
    for (const options of [
      { statementMetafield: '/pages/a' },
      { designMode: true },
      { ...full, blockScript: true },
    ] satisfies OpenOptions[]) {
      const fixture = await open(browser, options);
      try {
        if ((await fixture.page.$('summary')) !== null) await fixture.page.click('summary');
        expect(await axe(fixture.page), JSON.stringify(options)).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
  });

  it('on the embed alone as well as on the whole page', async () => {
    const fixture = await open(browser, full);
    try {
      await fixture.page.click('summary');
      expect(await axe(fixture.page, '[data-rampsmith-a11y]')).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe('the axe run itself', () => {
  it('finds nothing on the theme fixture without the embed, so every finding would be the embed’s', async () => {
    const fixture = await open(browser, {});
    try {
      expect(await fixture.page.$('[data-rampsmith-a11y]')).toBeNull();
      expect(await axe(fixture.page)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('reports a seeded fault, so an empty result is real', async () => {
    const fixture = await open(browser, full);
    try {
      await fixture.page.evaluate(() => {
        document.querySelector('[data-rampsmith-a11y] label')?.remove();
      });
      await fixture.page.click('summary');
      const ids = (await axe(fixture.page)).map((v) => v.id);
      expect(ids).toContain('label');
    } finally {
      await fixture.close();
    }
  });
});
