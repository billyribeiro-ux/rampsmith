/**
 * The parts of the Shopify App Review checklist (PLAN §14; docs/evidence/r2-app-review-checklist.md)
 * that a browser can show about the embedded App Home: how App Bridge is loaded, that the app
 * needs no cookies or web storage and works in an incognito window, that no screen leaves the
 * admin frame or opens a pop-up, that nothing but Shopify's own scripts and the app's origin is
 * contacted, and that setup instructions link to the theme editor.
 */
import { expect, test, type Page } from '@playwright/test';
import { open, section } from './app-helpers.ts';

const APP_ORIGIN = 'http://127.0.0.1:3985';
/** Shopify's script host, which the tests answer with the Polaris shim (ADR-094). */
const SHOPIFY_CDN = 'https://cdn.shopify.com';

/** Opens every App Home screen, one document each, as Shopify's navigation does. */
async function visitEveryScreen(page: Page): Promise<void> {
  for (const [path, heading] of [
    ['/app', 'Overview'],
    ['/app/findings', 'Issues'],
    ['/app/fixes', 'Review fixes'],
    ['/app/log', 'Remediation log'],
    ['/app/statement', 'Accessibility statement'],
    ['/app/settings', 'Settings'],
  ] as const) {
    await open(page, 'default', path, heading);
    await expect(page.locator('s-banner[tone=critical]')).toHaveCount(0);
  }
}

test('App Bridge is the first script in the head, loaded synchronously, after the api key', async ({
  page,
}) => {
  await open(page, 'default', '/app', 'Overview');
  const head = await page.evaluate(() => {
    const scripts = [...document.head.querySelectorAll('script')];
    const key = document.head.querySelector('meta[name="shopify-api-key"]');
    const first = scripts[0];
    return {
      firstSrc: first?.getAttribute('src') ?? null,
      async: first?.hasAttribute('async') ?? null,
      defer: first?.hasAttribute('defer') ?? null,
      type: first?.getAttribute('type') ?? null,
      keyBeforeScript:
        key !== null && first !== undefined
          ? Boolean(key.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false,
      keyContent: key?.getAttribute('content') ?? null,
    };
  });
  expect(head.firstSrc).toBe(`${SHOPIFY_CDN}/shopifycloud/app-bridge.js`);
  expect([head.async, head.defer, head.type]).toEqual([false, false, null]);
  expect(head.keyBeforeScript).toBe(true);
  expect(head.keyContent).toBe('e2e-client-id');
});

test('no cookie and no web storage is used, so the app works in an incognito window', async ({
  page,
}) => {
  const setCookies: string[] = [];
  page.on('response', async (response) => {
    const header = await response.headerValue('set-cookie');
    if (header !== null) setCookies.push(`${response.url()}: ${header}`);
  });
  await page.addInitScript(() => {
    const touched: string[] = [];
    (globalThis as unknown as { __storage: string[] }).__storage = touched;
    // Any use of web storage is recorded; the app is expected to make none.
    for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
      Object.defineProperty(Storage.prototype, method, {
        value: () => {
          touched.push(method);
          return null;
        },
      });
    }
    Object.defineProperty(document, 'cookie', {
      get: () => {
        touched.push('cookie get');
        return '';
      },
      set: () => {
        touched.push('cookie set');
      },
    });
  });
  await visitEveryScreen(page);
  expect(
    await page.evaluate(() => (globalThis as unknown as { __storage: string[] }).__storage),
  ).toEqual([]);
  expect(setCookies).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test('moving between screens is client-side: no reload, no frame change, no pop-up', async ({
  page,
}) => {
  const popups: string[] = [];
  page.on('popup', (popup) => popups.push(popup.url()));
  await open(page, 'default', '/app', 'Overview');
  const documentLoads = (): Promise<number> =>
    page.evaluate(() => performance.getEntriesByType('navigation').length);
  await page.getByRole('link', { name: 'View all issues' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
  await page
    .getByRole('link', { name: 'The image of Linen tote bag has no useful description' })
    .click();
  await expect(page.getByText('Images need a short text description')).toBeVisible();
  await section(page, 'Fixes').getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review fixes' })).toBeVisible();
  // One document load, the one Shopify opened; the three moves reused it.
  expect(await documentLoads()).toBe(1);
  expect(page.mainFrame().url()).toContain('/app/fixes');
  expect(popups).toEqual([]);
});

test('only the app and Shopify are contacted: no analytics, fonts, payment forms or other third parties', async ({
  page,
}) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await visitEveryScreen(page);
  expect([...origins].sort()).toEqual([APP_ORIGIN, SHOPIFY_CDN].sort());
  await expect(page.locator('iframe[src*="stripe"], input[autocomplete^="cc-"]')).toHaveCount(0);
});

test('setup instructions link to the theme editor with the app embed switched on', async ({
  page,
}) => {
  await open(page, 'default', '/app/settings', 'Settings');
  const setup = section(page, 'Online store');
  await expect(setup).toContainText('off until you turn it on');
  const link = setup.getByRole('link', { name: 'Open the theme editor' });
  const href = (await link.getAttribute('href')) ?? '';
  const url = new URL(href);
  expect(url.origin).toBe('https://demo-store.myshopify.com');
  expect(url.pathname).toBe('/admin/themes/current/editor');
  expect(url.searchParams.get('context')).toBe('apps');
  expect(url.searchParams.get('activateAppId')).toBe('e2e-client-id/accessibility');
  await expect(link).toHaveAttribute('target', '_top');
});

test('plans are changed on Shopify’s hosted plan page, not in the app', async ({ page }) => {
  await open(page, 'free', '/app', 'Overview');
  const link = section(page, 'Plan').getByRole('link', { name: 'Compare plans' });
  await expect(link).toHaveAttribute(
    'href',
    'https://admin.shopify.com/store/demo-store/charges/rampsmith/pricing_plans',
  );
  await expect(page.getByRole('button', { name: /upgrade|subscribe|pay|buy/i })).toHaveCount(0);
});
