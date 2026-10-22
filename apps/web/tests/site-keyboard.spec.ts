import { expect, test, type Page } from '@playwright/test';
import { PAGES, SCHEMES } from './site-helpers.ts';

/** What the focus ring looks like on the element that has focus now. */
async function focusIndicator(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return null;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      name: element.textContent.trim().slice(0, 40),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      inViewport: (() => {
        const box = element.getBoundingClientRect();
        return box.bottom > 0 && box.top < innerHeight;
      })(),
    };
  });
}

for (const scheme of SCHEMES) {
  test.describe(`keyboard only, ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    for (const { path } of PAGES) {
      test(`${path}: focus is always visible, in order, and never trapped`, async ({ page }) => {
        await page.goto(path);
        const seen: string[] = [];
        let reachedLast = false;
        const stops = await page.evaluate(
          () =>
            document.querySelectorAll(
              'a[href], button:not([disabled]), input:not([type="hidden"]), [tabindex="0"]',
            ).length,
        );
        // Every stop, plus the one that leaves the page.
        for (let i = 0; i < stops + 2; i += 1) {
          await page.keyboard.press('Tab');
          const indicator = await focusIndicator(page);
          if (indicator === null) {
            reachedLast = true;
            break;
          }
          expect(indicator.style, `${indicator.tag} "${indicator.name}"`).not.toBe('none');
          expect(indicator.width, `${indicator.tag} "${indicator.name}"`).toBeGreaterThanOrEqual(2);
          // The skip link slides in over 150 ms, so the check waits for it to arrive.
          await expect
            .poll(async () => (await focusIndicator(page))?.inViewport ?? true, {
              message: `${indicator.tag} "${indicator.name}" is on screen`,
            })
            .toBe(true);
          seen.push(`${indicator.tag}:${indicator.name}`);
        }
        // The first stop is the skip link, and Tab eventually leaves the page.
        expect(seen[0]).toBe('a:Skip to main content');
        expect(reachedLast || seen.length === stops).toBe(true);
      });
    }
  });
}

test('the skip link moves focus to the main content on every page', async ({ page }) => {
  for (const { path } of PAGES) {
    await page.goto(path);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    // The next Tab starts inside the content, not back in the header.
    await page.keyboard.press('Tab');
    const inMain = await page.evaluate(
      () => document.querySelector('main')?.contains(document.activeElement) ?? false,
    );
    expect(inMain, path).toBe(true);
  }
});

test('the header navigation can be used with Enter alone', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Pricing' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pricing$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pricing');
});

test('wide tables can be scrolled from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto('/pricing');
  const region = page.locator('div[role="region"][tabindex="0"]');
  await region.focus();
  await expect(region).toBeFocused();
  const before = await region.evaluate((el) => el.scrollLeft);
  await page.keyboard.press('ArrowRight');
  // Arrow keys scroll a focused region, smoothly in some browsers, so wait for it to move.
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
});

test('text can be enlarged to 200% of the default without losing content', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('link', { name: 'Scan your site free' }).first()).toBeVisible();
});
