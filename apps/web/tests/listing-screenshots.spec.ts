/**
 * Retakes the Shopify App Store listing screenshots from the running App Home against the typed
 * fake api (LAUNCH.md section B). Shopify asks for 3 to 6 desktop screenshots of 1600 x 900
 * pixels, cropped of browser chrome, with alt text and no personal data, pricing, reviews or
 * outcome promises ("Best practices for apps in the Shopify App Store", read 23 October 2026,
 * ADR-301). The viewport is exactly 1600 x 900 at a device scale of 1, so each file is that size.
 *
 * The Polaris components are the repository's test shim (ADR-094), so the files show the app's
 * own layout and copy with the shim's styling. The founder retakes them on a development store
 * with Shopify's Polaris before submission (LAUNCH.md section E).
 */
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { open, section } from './app-helpers.ts';
import type { ScenarioName } from './app-fake-api.ts';

const OUT = fileURLToPath(new URL('../../../listing/screenshots/', import.meta.url));

interface Shot {
  readonly file: string;
  readonly scenario: ScenarioName;
  readonly path: string;
  readonly heading: string | RegExp;
  readonly ready: string;
}

const SHOTS: readonly Shot[] = [
  {
    file: '01-overview.png',
    scenario: 'default',
    path: '/app',
    heading: 'Overview',
    ready: 'Latest scan',
  },
  {
    file: '02-issues.png',
    scenario: 'default',
    path: '/app/findings',
    heading: 'Issues',
    ready: '',
  },
  {
    file: '03-issue-detail.png',
    scenario: 'default',
    path: '/app/findings/00000000-0000-4000-8000-000000000102',
    heading: /./,
    ready: 'WCAG 2.2 criteria',
  },
  {
    file: '04-review-fixes.png',
    scenario: 'default',
    path: '/app/fixes',
    heading: 'Review fixes',
    ready: 'Applied changes',
  },
  {
    file: '05-remediation-log.png',
    scenario: 'default',
    path: '/app/log',
    heading: 'Remediation log',
    ready: '',
  },
  {
    file: '06-accessibility-statement.png',
    scenario: 'default',
    path: '/app/statement',
    heading: 'Accessibility statement',
    ready: '',
  },
];

/** Simple product illustrations for the demo store, so no card shows a missing image. */
const ART: Readonly<Record<string, string>> = {
  'blue-ceramic-mug':
    '<rect width="160" height="160" fill="#e8eef7"/><rect x="40" y="52" width="64" height="62" rx="10" fill="#2c5aa0"/><path d="M104 66h12a14 14 0 0 1 0 28h-12" fill="none" stroke="#2c5aa0" stroke-width="9"/>',
  'linen-tote-bag':
    '<rect width="160" height="160" fill="#f3efe6"/><rect x="40" y="62" width="80" height="76" rx="4" fill="#d9c7a3"/><path d="M58 62c0-34 44-34 44 0" fill="none" stroke="#7a5230" stroke-width="7"/>',
  'brass-desk-lamp':
    '<rect width="160" height="160" fill="#f5f1e4"/><rect x="52" y="128" width="56" height="8" rx="3" fill="#8d6e1f"/><path d="M80 128V76l30-30" fill="none" stroke="#b68b2a" stroke-width="7"/><path d="M96 34l32 20-14 14-32-20z" fill="#c99a2e"/>',
  'wool-throw-blanket':
    '<rect width="160" height="160" fill="#eceff1"/><rect x="30" y="50" width="100" height="62" rx="6" fill="#8e99a4"/><path d="M30 70h100M30 90h100" stroke="#6f7b87" stroke-width="4"/>',
};
const artFor = (slug: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">${ART[slug] ?? ART['blue-ceramic-mug'] ?? ''}</svg>`;

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

for (const shot of SHOTS) {
  test(`screenshot ${shot.file}`, async ({ page }) => {
    await page.route('**/app/api/shopify/fixes**', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        items: { product_title: string; image_url: string | null }[];
      };
      for (const item of body.items) {
        item.image_url = `https://cdn.shopify.com/demo/${item.product_title.toLowerCase().replaceAll(' ', '-')}.png`;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route('**/app/api/media**', (route) => {
      const wanted = new URL(route.request().url()).searchParams.get('u') ?? '';
      const slug = /\/([a-z-]+)\.png$/u.exec(wanted)?.[1] ?? '';
      return route.fulfill({ contentType: 'image/svg+xml', body: artFor(slug) });
    });
    await open(page, shot.scenario, shot.path, shot.heading);
    if (shot.ready !== '') await expect(section(page, shot.ready)).toBeVisible();
    await page.waitForLoadState('networkidle');
    if (shot.file.startsWith('06-')) {
      await page.getByRole('textbox', { name: 'Business name' }).fill('Demo Store Ltd');
      await page.getByRole('textbox', { name: /^Email/ }).fill('access@demo-store.example');
      await page
        .getByRole('textbox', { name: /What you do for accessibility/ })
        .fill('We test new pages with a screen reader\nWe review alt text every month');
      await expect(
        page
          .frameLocator('iframe[title="Preview of your accessibility statement"]')
          .locator('body'),
      ).toContainText('Demo Store', { timeout: 15_000 });
    }
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${OUT}${shot.file}`, animations: 'disabled', caret: 'initial' });
  });
}
