// Live checks (LAUNCH.md section E). They run when the founder's inputs are present and
// otherwise skip with a notice naming the rows of LAUNCH.md section C they need; they never
// pass silently. The substitutes that pass now are the fixture tests in this package.
//
// Before the first run, deploy the extension (`shopify app deploy`) and enable the embed, with
// its barrier-report form on, on development store A once, through the deep link the failure
// message prints. The uninstall check runs only when asked (RAMPSMITH_LIVE_AFTER_UNINSTALL=1),
// after the founder has uninstalled the app from that store.
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { axe, launch } from '../src/browser.ts';
import { MIN_ELAPSED_MS } from '../src/barrier-report.ts';

const domain = process.env['SHOPIFY_DEV_STORE_DOMAIN'] ?? '';
const password = process.env['SHOPIFY_DEV_STORE_PASSWORD'] ?? '';
const apiKey = process.env['SHOPIFY_API_KEY'] ?? '';
const railway = process.env['RAILWAY_TOKEN'] ?? '';
const afterUninstall = process.env['RAMPSMITH_LIVE_AFTER_UNINSTALL'] === '1';

const STORE_ROWS =
  'LAUNCH.md section C rows 1 and 3 (SHOPIFY_API_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_STORE_PASSWORD)';
const PROXY_ROWS =
  'LAUNCH.md section C rows 1, 3 and 8 (the store inputs and RAILWAY_TOKEN, with the api deployed to staging)';
const UNINSTALL_ROWS =
  'LAUNCH.md section C row 3 (SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_STORE_PASSWORD) and RAMPSMITH_LIVE_AFTER_UNINSTALL=1 once the app is uninstalled';
const storeReady = domain !== '' && password !== '' && apiKey !== '' && !afterUninstall;
const proxyReady = storeReady && railway !== '';
const uninstallReady = domain !== '' && password !== '' && afterUninstall;

for (const [ready, what, rows] of [
  [storeReady, 'theme app extension on a development store', STORE_ROWS],
  [proxyReady, 'barrier report through the live app proxy', PROXY_ROWS],
  [uninstallReady, 'no trace of the extension after uninstall', UNINSTALL_ROWS],
] as const) {
  if (!ready) process.stderr.write(`LIVE CHECK SKIPPED: ${what} needs ${rows}.\n`);
}

let browser: Browser | undefined;
beforeAll(async () => {
  if (storeReady || uninstallReady) browser = await launch(inject('chromiumPath'));
});
afterAll(async () => {
  await browser?.close();
});

/** Opens the store's home page past its storefront password, which is never logged. */
async function home() {
  if (browser === undefined) throw new Error('no browser');
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = `https://${domain}`;
  await page.goto(`${origin}/password`);
  const field = page.locator('input[type="password"]');
  if ((await field.count()) > 0) {
    await field.first().fill(password);
    await Promise.all([page.waitForURL(`${origin}/**`), field.first().press('Enter')]);
  }
  await page.goto(`${origin}/`);
  return { context, page, origin };
}

async function storefront() {
  const { context, page, origin } = await home();
  const embed = page.locator('[data-rampsmith-a11y]');
  if ((await embed.count()) === 0) {
    throw new Error(
      `The Rampsmith embed is not on ${origin}/. Deploy the extension, then enable it at ` +
        `https://${domain}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/accessibility`,
    );
  }
  return { context, page, origin };
}

describe('live: the theme app extension on a development store', () => {
  it.skipIf(!storeReady)(
    `renders, passes axe and loads at most 5 KB of script (needs ${STORE_ROWS})`,
    async () => {
      const { context, page } = await storefront();
      try {
        expect(await axe(page, '[data-rampsmith-a11y]')).toEqual([]);
        const script = page.locator('[data-rampsmith-a11y] script[src]');
        const src = await script.getAttribute('src');
        expect(src, 'turn the barrier report form on in the embed settings').not.toBeNull();
        const response = await context.request.get(new URL(src ?? '', page.url()).toString());
        expect((await response.body()).byteLength).toBeLessThan(5 * 1024);
        expect(await script.getAttribute('defer')).not.toBeNull();
      } finally {
        await context.close();
      }
    },
  );

  it.skipIf(!proxyReady)(
    `sends a report through the signed app proxy (needs ${PROXY_ROWS})`,
    async () => {
      const { context, page } = await storefront();
      try {
        await page.locator('[data-rampsmith-a11y] summary').click();
        await page
          .locator('[data-rampsmith-a11y] textarea[name="description"]')
          .fill('Rampsmith live check: please ignore.');
        await page.waitForTimeout(MIN_ELAPSED_MS + 500);
        const [response] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/barrier-report') && r.request().method() === 'POST',
          ),
          page.locator('[data-rampsmith-a11y] button[type="submit"]').click(),
        ]);
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ status: 'received' });
      } finally {
        await context.close();
      }
    },
  );

  it.skipIf(!uninstallReady)(
    `leaves no trace on the storefront after uninstall (needs ${UNINSTALL_ROWS})`,
    async () => {
      const { context, page } = await home();
      try {
        const html = await page.content();
        expect(html).not.toContain('data-rampsmith-a11y');
        expect(html).not.toContain('rs-a11y');
        expect(html).not.toContain('rampsmith-barrier-report');
      } finally {
        await context.close();
      }
    },
  );
});
