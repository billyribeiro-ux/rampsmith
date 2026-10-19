// The barrier-report form in Chromium: keyboard operation, focus, names and descriptions from
// the browser's accessibility tree, error states, every answer the app proxy can give, and
// the same form with JavaScript off.
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PAGE_URL, axNode, launch, open, type Fixture, type OpenOptions } from '../src/browser.ts';
import { MIN_ELAPSED_MS } from '../src/barrier-report.ts';

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
const ID = 'rs-a11y-AdGh1Q3Bp';
const TEXTAREA = `#${ID}-description`;
const EMAIL = `#${ID}-email`;
const SUBMIT = 'button[type="submit"]';
const STATUS = '[data-rs-status]';
const REPORT = 'The size picker cannot be reached with the keyboard.';

async function withFixture(
  options: OpenOptions,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await open(browser, options);
  try {
    await body(fixture);
  } finally {
    await fixture.close();
  }
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return '';
    return el.id === '' ? `${el.tagName.toLowerCase()}:${el.textContent.trim()}` : `#${el.id}`;
  });

const statusText = (page: Page) => page.textContent(STATUS);

/** Waits until a person could have typed the report, so the fake api keeps it. */
const humanPause = (page: Page) => page.waitForTimeout(MIN_ELAPSED_MS + 100);

describe('keyboard', () => {
  it('reaches every control in order, opens the form with Enter, and skips the honeypot', async () => {
    await withFixture(OPTIONS, async ({ page }) => {
      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        order.push(await focused(page));
      }
      expect(order).toEqual([
        'a:Home',
        'a:Catalog',
        'a:Accessibility',
        'summary:Report an accessibility barrier',
      ]);
      await page.keyboard.press('Enter');
      expect(await page.getAttribute('details', 'open')).toBe('');
      const inside: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        inside.push(await focused(page));
      }
      expect(inside).toEqual([TEXTAREA, EMAIL, 'a:Privacy policy', 'button:Send report']);
      await page.keyboard.press('Shift+Tab');
      expect(await focused(page)).toBe('a:Privacy policy');
    });
  });

  it('shows a visible focus ring of at least 2 px on every control it reaches', async () => {
    await withFixture(OPTIONS, async ({ page }) => {
      const ring = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || el.closest('[data-rampsmith-a11y]') === null) {
            return null;
          }
          const style = getComputedStyle(el);
          return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
        });
      const rings: ({ style: string; width: number } | null)[] = [];
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      rings.push(await ring());
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        rings.push(await ring());
      }
      await page.keyboard.press('Shift+Tab');
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+Tab');
      rings.push(await ring());
      expect(rings).toHaveLength(6);
      for (const r of rings) {
        expect(r?.style).not.toBe('none');
        expect(r?.width).toBeGreaterThanOrEqual(2);
      }
    });
  });

  it('closes the form again with Enter on its summary', async () => {
    await withFixture(OPTIONS, async ({ page }) => {
      await page.focus('summary');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await page.getAttribute('details', 'open')).toBeNull();
    });
  });
});

describe('names and descriptions', () => {
  it('labels the region and every control, and describes the fields by their hints', async () => {
    await withFixture(OPTIONS, async ({ page }) => {
      await page.click('summary');
      expect(await axNode(page, 'aside[data-rampsmith-a11y]')).toMatchObject({
        role: 'complementary',
        name: 'Accessibility information',
      });
      expect(await axNode(page, 'summary')).toMatchObject({
        name: 'Report an accessibility barrier',
      });
      expect(await axNode(page, TEXTAREA)).toMatchObject({
        role: 'textbox',
        name: 'What happened? (required)',
        required: true,
        invalid: false,
      });
      expect((await axNode(page, TEXTAREA)).description).toMatch(/^Describe the problem/u);
      expect(await axNode(page, EMAIL)).toMatchObject({
        role: 'textbox',
        name: 'Email (optional)',
        description: 'Only if you would like a reply.',
        required: false,
      });
      expect(await axNode(page, SUBMIT)).toMatchObject({ role: 'button', name: 'Send report' });
      expect(await axNode(page, STATUS)).toMatchObject({ role: 'status' });
      expect((await axNode(page, `#${ID}-website`)).focusable).toBe(false);
    });
  });
});

describe('errors', () => {
  it('moves focus to the first problem, marks it invalid and adds the error to its description', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      await page.click('summary');
      await page.fill(EMAIL, 'not-an-email');
      await page.click(SUBMIT);
      expect(await focused(page)).toBe(TEXTAREA);
      const description = await axNode(page, TEXTAREA);
      expect(description.invalid).toBe(true);
      expect(description.description).toContain('Error: Describe the barrier you found.');
      const email = await axNode(page, EMAIL);
      expect(email.invalid).toBe(true);
      expect(email.description).toContain(
        'Error: Enter an email address like name@example.com, or leave it empty.',
      );
      expect(proxy.hits).toEqual([]);
    });
  });

  it('clears an error as soon as the field is fixed, and never adds one while typing', async () => {
    await withFixture(OPTIONS, async ({ page }) => {
      await page.click('summary');
      await page.click(SUBMIT);
      await page.locator(TEXTAREA).pressSequentially('Low');
      expect(await page.getAttribute(TEXTAREA, 'aria-invalid')).toBeNull();
      expect(await page.textContent(`#${ID}-description-error`)).toBe('');
      await page.locator(EMAIL).pressSequentially('half@');
      expect(await page.getAttribute(EMAIL, 'aria-invalid')).toBeNull();
    });
  });

  it('treats a description of only spaces as missing', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      await page.click('summary');
      await page.fill(TEXTAREA, '   ');
      await page.click(SUBMIT);
      expect(await page.getAttribute(TEXTAREA, 'aria-invalid')).toBe('true');
      expect(proxy.hits).toEqual([]);
    });
  });

  it('shows the api’s own field errors, moves focus to the field and says why in the status', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      proxy.mode = 'server-invalid';
      await page.click('summary');
      await page.fill(TEXTAREA, REPORT);
      await page.fill(EMAIL, 'person@example.com');
      await page.click(SUBMIT);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-rs-status]')?.textContent !== 'Sending your report…' &&
          document.querySelector('[data-rs-status]')?.textContent !== '',
      );
      expect(await statusText(page)).toBe('Please correct the errors in the form.');
      expect(await focused(page)).toBe(EMAIL);
      expect(await page.getAttribute(EMAIL, 'aria-invalid')).toBe('true');
    });
  });
});

describe('sending', () => {
  it('sends the report through the signed app proxy, announces it, and clears the form', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      await page.click('summary');
      await page.fill(TEXTAREA, REPORT);
      await page.fill(EMAIL, 'shopper@example.com');
      await humanPause(page);
      await page.click(SUBMIT);
      await page.waitForFunction(() =>
        document.querySelector('[data-rs-status]')?.textContent.startsWith('Thank you'),
      );
      expect(await statusText(page)).toBe('Thank you. Your report was sent to the store.');
      expect(proxy.stored).toEqual([
        {
          description: REPORT,
          email: 'shopper@example.com',
          page: '/products/blue-shirt',
          pageType: 'product',
          locale: 'en',
        },
      ]);
      const [hit] = proxy.hits;
      expect(hit?.method).toBe('POST');
      expect(hit?.accept).toBe('application/json');
      expect([...(hit?.fields.keys() ?? [])].sort()).toEqual(
        ['description', 'elapsed_ms', 'email', 'locale', 'page', 'page_type', 'website'].sort(),
      );
      expect(await page.inputValue(TEXTAREA)).toBe('');
      expect(await page.inputValue(EMAIL)).toBe('');
      expect(await focused(page)).toBe('button:Send report');
      expect(await page.getAttribute(SUBMIT, 'aria-disabled')).toBeNull();
    });
  });

  it('says it is sending, keeps focus on the button, and sends once however often it is pressed', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      proxy.delayMs = 800;
      await page.click('summary');
      await page.fill(TEXTAREA, REPORT);
      await humanPause(page);
      await page.focus(SUBMIT);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await statusText(page)).toBe('Sending your report…');
      expect(await page.getAttribute(SUBMIT, 'aria-disabled')).toBe('true');
      expect(await focused(page)).toBe('button:Send report');
      await page.waitForFunction(() =>
        document.querySelector('[data-rs-status]')?.textContent.startsWith('Thank you'),
      );
      expect(proxy.hits).toHaveLength(1);
    });
  });

  const failures: [string, Fixture['proxy']['mode'], string][] = [
    [
      'rate limiting',
      'rate-limited',
      'Too many reports were sent from here. Please try again later.',
    ],
    ['a server error', 'server-error', 'Your report could not be sent. Please try again later.'],
    [
      'a non-JSON error page',
      'html-error',
      'Your report could not be sent. Please try again later.',
    ],
    [
      'a dropped connection',
      'connection-reset',
      'Your report could not be sent. Please try again later.',
    ],
  ];
  for (const [name, mode, message] of failures) {
    it(`keeps what was typed and says so on ${name}`, async () => {
      await withFixture(OPTIONS, async ({ page, proxy }) => {
        proxy.mode = mode;
        await page.click('summary');
        await page.fill(TEXTAREA, REPORT);
        await page.click(SUBMIT);
        await page.waitForFunction(
          (text) => document.querySelector('[data-rs-status]')?.textContent === text,
          message,
        );
        expect(await page.inputValue(TEXTAREA)).toBe(REPORT);
        expect(await page.getAttribute(SUBMIT, 'aria-disabled')).toBeNull();
      });
    });
  }

  it('lets the api drop a report sent faster than a person could type it, without telling the sender', async () => {
    await withFixture(OPTIONS, async ({ page, proxy }) => {
      await page.click('summary');
      await page.fill(TEXTAREA, REPORT);
      await page.click(SUBMIT);
      await page.waitForFunction(() =>
        document.querySelector('[data-rs-status]')?.textContent.startsWith('Thank you'),
      );
      expect(proxy.hits).toHaveLength(1);
      expect(proxy.stored).toEqual([]);
    });
  });
});

describe('without JavaScript', () => {
  const noScript: OpenOptions = { ...OPTIONS, javaScript: false };

  it('opens with the native disclosure and lets the browser refuse an empty report', async () => {
    await withFixture(noScript, async ({ page, proxy }) => {
      await page.click('summary');
      expect(await page.isVisible(TEXTAREA)).toBe(true);
      await page.click(SUBMIT);
      expect(page.url()).toBe(PAGE_URL);
      expect(
        await page.$eval(TEXTAREA, (el) => (el as HTMLTextAreaElement).validity.valueMissing),
      ).toBe(true);
      expect(proxy.hits).toEqual([]);
    });
  });

  it('posts the form to the app proxy, which answers with its own page', async () => {
    await withFixture(noScript, async ({ page, proxy }) => {
      await page.click('summary');
      await page.fill(TEXTAREA, REPORT);
      await Promise.all([page.waitForURL('**/apps/rampsmith/barrier-report'), page.click(SUBMIT)]);
      expect(await page.textContent('h1')).toBe('Report sent');
      expect(proxy.stored).toEqual([
        {
          description: REPORT,
          email: null,
          page: '/products/blue-shirt',
          pageType: 'product',
          locale: 'en',
        },
      ]);
      const [hit] = proxy.hits;
      expect(hit?.accept).not.toContain('application/json');
      expect(hit?.fields.has('elapsed_ms')).toBe(false);
    });
  });
});
