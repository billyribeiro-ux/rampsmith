import { expect, test } from '@playwright/test';
import { axe, PROXY_HEADERS, SCHEMES, SITE_API } from './site-helpers.ts';

test.use({ baseURL: SITE_API, extraHTTPHeaders: PROXY_HEADERS });

for (const scheme of SCHEMES) {
  test.describe(`email link pages, ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('the unsubscribe page changes nothing until a button is pressed, and has no violations', async ({
      page,
    }) => {
      await page.goto('/email/unsubscribe?t=unsub-ok');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email from Rampsmith');
      await expect(page.getByText('On: this address receives these emails.')).toBeVisible();
      await axe(page);
    });

    test('turning a category off and on again works, and the page says so', async ({ page }) => {
      await page.goto('/email/unsubscribe?t=unsub-ok');
      await page.getByRole('button', { name: 'Turn off Store notifications' }).click();
      await expect(page.getByRole('status')).toContainText(
        'Done. Store notifications are off for this address.',
      );
      await expect(
        page.getByText('Off: this address does not receive these emails.'),
      ).toBeVisible();
      await axe(page);
      await page.getByRole('button', { name: 'Turn on Store notifications' }).click();
      await expect(page.getByRole('status')).toContainText('are on for this address');
    });

    test('the preferences page lists each category with its own button', async ({ page }) => {
      await page.goto('/email/preferences?t=prefs-both');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email preferences');
      await expect(
        page.getByRole('list', { name: 'Email categories' }).getByRole('listitem'),
      ).toHaveCount(2);
      await axe(page);
    });

    for (const [token, heading] of [
      ['expired', 'This link has expired'],
      ['nonsense', 'This link does not work'],
      ['', 'This link does not work'],
    ] as const) {
      test(`a "${token}" link says so and has no violations`, async ({ page }) => {
        await page.goto(`/email/unsubscribe?t=${token}`);
        await expect(page.getByRole('heading', { level: 2 })).toHaveText(heading);
        await axe(page);
      });
    }
  });
}

test('the pages are private: not cached, not indexed, no referrer to other sites', async ({
  page,
}) => {
  const response = await page.goto('/email/unsubscribe?t=unsub-ok');
  const headers = response?.headers() ?? {};
  expect(headers['cache-control']).toContain('no-store');
  expect(headers['x-robots-tag']).toContain('noindex');
  expect(headers['referrer-policy']).toBe('same-origin');
});

test('works with the keyboard alone, with a visible focus ring, and without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    extraHTTPHeaders: PROXY_HEADERS,
    baseURL: SITE_API,
  });
  const page = await context.newPage();
  await page.goto('/email/unsubscribe?t=unsub-ok');
  const button = page.getByRole('button', { name: 'Turn off Store notifications' });
  await button.focus();
  await expect(button).toBeFocused();
  const outline = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('are off for this address');
  await context.close();
});
