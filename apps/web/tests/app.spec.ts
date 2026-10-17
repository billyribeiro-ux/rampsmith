import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Replaces Shopify's CDN scripts with a fake App Bridge that hands out `tokens` in order. */
async function embedded(page: Page, tokens: string[]) {
  await page.route('https://cdn.shopify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  await page.addInitScript((queue: string[]) => {
    (globalThis as unknown as { shopify: unknown }).shopify = {
      idToken: () => Promise.resolve(queue.shift() ?? 'none'),
    };
  }, tokens);
}

test('the home page is accessible and cannot be framed', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Accessibility fixed at the source',
  );
  await axe(page);
});

test('the skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('the embedded app loads App Bridge, may be framed by the shop, and starts a session', async ({
  page,
}) => {
  await embedded(page, ['good']);
  const response = await page.goto('/app?shop=demo-store.myshopify.com&host=abc');
  expect(response?.headers()['content-security-policy']).toContain(
    'frame-ancestors https://admin.shopify.com https://demo-store.myshopify.com',
  );
  await expect(page.locator('meta[name="shopify-api-key"]')).toHaveAttribute(
    'content',
    'e2e-client-id',
  );
  await expect(page.locator('head script[src$="/shopifycloud/app-bridge.js"]')).toHaveCount(1);
  await expect(page.locator('head script[src$="/shopifycloud/polaris-1.1.js"]')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText(
    'Rampsmith is installed on demo-store.myshopify.com.',
  );
  await axe(page);
});

test('a stale session token is replaced once and the session starts', async ({ page }) => {
  await embedded(page, ['stale', 'good']);
  await page.goto('/app?shop=demo-store.myshopify.com');
  await expect(page.getByRole('status')).toHaveText(
    'Rampsmith is installed on demo-store.myshopify.com.',
  );
});

test('a session that cannot start says so accessibly', async ({ page }) => {
  await embedded(page, ['bad', 'worse']);
  await page.goto('/app?shop=demo-store.myshopify.com');
  await expect(page.getByText('Rampsmith could not reach your store')).toBeVisible();
  await axe(page);
});

test('unknown pages answer 404 with an accessible page', async ({ page }) => {
  const response = await page.goto('/nope');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await axe(page);
});
