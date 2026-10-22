import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ScenarioName } from './app-fake-api.ts';

const FAKE_API = 'http://127.0.0.1:3984';
export const SHOP = 'shop=demo-store.myshopify.com&host=abc&embedded=1';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The shim is TypeScript so it is type-checked; the browser gets it with the types erased. */
const SHIM = stripTypeScriptTypes(
  readFileSync(new URL('./polaris-shim.ts', import.meta.url), 'utf8'),
);

/** Axe at WCAG 2.2 A and AA over the whole page, shadow roots included: zero violations. */
export async function axe(page: Page, exclude: string[] = []): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(WCAG);
  for (const selector of exclude) builder.exclude(selector);
  const results = await builder.analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`,
    ),
  ).toEqual([]);
}

/** Resets the fake api to a scenario. */
export async function reset(scenario: ScenarioName): Promise<void> {
  const response = await fetch(`${FAKE_API}/__scenario`, {
    method: 'POST',
    body: JSON.stringify({ name: scenario }),
  });
  expect(response.ok).toBe(true);
}

export async function requestsSeen(): Promise<
  { method: string; path: string; authorization: string | null }[]
> {
  return (await (await fetch(`${FAKE_API}/__requests`)).json()) as never;
}

/** Serves the Polaris test shim and a fake App Bridge in place of Shopify's scripts. */
export async function shopify(page: Page): Promise<void> {
  await page.route('https://cdn.shopify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  await page.route('https://cdn.shopify.com/shopifycloud/polaris-1.1.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: SHIM }),
  );
  await page.addInitScript(() => {
    (globalThis as unknown as { shopify: unknown }).shopify = {
      idToken: () => Promise.resolve('good'),
    };
  });
}

/** Opens an App Home screen in a scenario and waits for its page heading. */
export async function open(
  page: Page,
  scenario: ScenarioName,
  path: string,
  heading: string | RegExp,
): Promise<void> {
  await reset(scenario);
  await shopify(page);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}${SHOP}`);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/**
 * The `<s-section>` with a heading. The section's own `<section>` lives in its shadow root, so
 * a `region` role locator would not contain the slotted content; the host element does.
 */
export function section(page: Page, heading: string): Locator {
  return page
    .locator('s-section')
    .filter({ has: page.getByRole('heading', { level: 2, name: heading, exact: true }) });
}
