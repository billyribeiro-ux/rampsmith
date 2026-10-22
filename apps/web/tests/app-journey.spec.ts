/**
 * The scripted install-to-first-fix journey (PLAN §5 R1 exit criterion: median under 10
 * minutes). A merchant opens the app for the first time, starts a scan, waits for results,
 * reviews the first AI alt text draft, approves it, sees it applied, finds it in the log, and
 * undoes it. The script runs against the typed fake api, so it measures the app's own steps
 * and waits (scan polling, apply polling), not Shopify or Claude; the live measure on
 * development stores is LAUNCH.md section E (docs/evidence/r1-lane-c.md).
 */
import { expect, test } from '@playwright/test';
import { axe, open, section } from './app-helpers.ts';

const BUDGET_MS = 10 * 60_000;

test('install to first fix in well under ten minutes, accessible at every step', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const steps: { step: string; ms: number }[] = [];
  const started = Date.now();
  const mark = (step: string): void => {
    steps.push({ step, ms: Date.now() - started });
  };

  // 1. First open: no scan yet.
  await open(page, 'fresh', '/app', 'Overview');
  await expect(page.getByRole('heading', { name: 'No scan yet' })).toBeVisible();
  await axe(page);
  mark('opened the app');

  // 2. Start the first scan with the keyboard and wait for it to finish.
  const start = page.locator('s-empty-state').getByRole('button', { name: 'Start a scan' });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.live')).toHaveText(
    'Scan started. Results appear here as pages are checked.',
  );
  await expect(section(page, 'Latest scan')).toContainText('Finished', { timeout: 30_000 });
  await axe(page);
  mark('first scan finished');
  await expect(section(page, 'Issues')).toContainText('Serious');
  await expect(section(page, 'Fixes')).toContainText('Fixes waiting for your review: 4');

  // 3. Open the review queue and read the first draft.
  await page.getByRole('link', { name: 'Review fixes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review fixes' })).toBeVisible();
  const first = page.getByRole('article').first();
  await expect(first).toContainText('Suggested alt text');
  await axe(page);
  mark('opened the review queue');

  // 4. Approve it with the keyboard; it is applied in the background.
  const name = (await first.getByRole('heading', { level: 3 }).innerText()).trim();
  await page.getByRole('button', { name: `Approve alt text for ${name}` }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.live')).toHaveText(new RegExp(`Approved the alt text for ${name}`));
  const applied = section(page, 'Applied changes');
  await expect(applied.getByRole('heading', { level: 3, name })).toBeVisible({ timeout: 20_000 });
  mark('first fix applied');
  await axe(page);

  // 5. The overview now counts it, and the remediation log records who approved what.
  await page.goto(`/app?shop=demo-store.myshopify.com&host=abc&embedded=1`);
  await expect(section(page, 'Fixes')).toContainText('Fixes applied: 1');
  await page.goto(`/app/log?shop=demo-store.myshopify.com&host=abc&embedded=1`);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Sam Merchant');
  await expect(row).toContainText('Applied');
  await axe(page);
  mark('fix is in the remediation log');

  // 6. One-click undo from the review screen.
  await page.goto(`/app/fixes?shop=demo-store.myshopify.com&host=abc&embedded=1`);
  await page.getByRole('button', { name: `Undo alt text change for ${name}` }).click();
  await expect(page.locator('.live')).toHaveText(
    new RegExp(`Undid the alt text change for ${name}`),
  );
  await expect(applied.getByRole('heading', { level: 3, name })).toHaveCount(0);
  mark('fix undone');

  const total = Date.now() - started;
  await info.attach('journey-steps.json', {
    body: JSON.stringify({ total, steps }, null, 2),
    contentType: 'application/json',
  });
  expect(total).toBeLessThan(BUDGET_MS);
});
